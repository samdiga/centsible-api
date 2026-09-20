import {
  createWorker,
  type WorkerDependencies,
  type WorkerRuntime,
} from "../app/create-worker.js";
import { loadEnv, type Env } from "../platform/config/env.js";
import { closeDb } from "../platform/database/client.js";
import { installGracefulShutdown } from "../platform/http/shutdown.js";
import {
  createWorkerWakeServer,
  type WorkerWakeServer,
} from "../platform/jobs/worker-wake.js";
import { logger } from "../platform/logging/logger.js";

type EntrypointLogger = {
  info: (bindings: Record<string, unknown>, message: string) => unknown;
  error: (bindings: Record<string, unknown>, message: string) => unknown;
};

export type WorkerStartDependencies = WorkerDependencies & {
  loadEnv?: (() => Env) | undefined;
  createWorker?: typeof createWorker | undefined;
  closeDb?: (() => Promise<void>) | undefined;
  installGracefulShutdown?: typeof installGracefulShutdown | undefined;
  logger?: EntrypointLogger | undefined;
  revision?: string | undefined;
  createWakeServer?: typeof createWorkerWakeServer | undefined;
  setTimeoutFn?: typeof setTimeout | undefined;
  clearTimeoutFn?: typeof clearTimeout | undefined;
  now?: (() => number) | undefined;
};

export type WorkerEntrypointRuntime = {
  worker: WorkerRuntime;
  close: () => Promise<void>;
  uninstallShutdown: () => void;
};

type Failure =
  Readonly<{ present: false }> | Readonly<{ present: true; value: unknown }>;

const noFailure: Failure = { present: false };

function capturedFailure(value: unknown): Failure {
  return { present: true, value };
}

async function cleanupLifecycle(
  actions: readonly (() => void | Promise<void>)[],
  primaryFailure: Failure = noFailure,
): Promise<void> {
  const failures: unknown[] = [];
  if (primaryFailure.present) failures.push(primaryFailure.value);
  for (const action of actions) {
    try {
      await action();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Worker lifecycle cleanup failed");
}

/** Starts only the worker role and wires its process-owned shutdown lifecycle. */
export async function startWorker(
  dependencies: WorkerStartDependencies = {},
): Promise<WorkerEntrypointRuntime> {
  const configuration = (dependencies.loadEnv ?? loadEnv)();
  const databaseClose = dependencies.closeDb ?? closeDb;
  const entrypointLogger = dependencies.logger ?? logger;
  const scheduleTimeout = dependencies.setTimeoutFn ?? setTimeout;
  const unscheduleTimeout = dependencies.clearTimeoutFn ?? clearTimeout;
  const now = dependencies.now ?? Date.now;
  let worker: WorkerRuntime | undefined;
  let wakeServer: WorkerWakeServer | undefined;
  let sweepTimer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let triggerPromise: Promise<void> | undefined;
  let sweepRequested = false;

  const clearSweepTimer = (): void => {
    if (sweepTimer === undefined) return;
    unscheduleTimeout(sweepTimer);
    sweepTimer = undefined;
  };

  const scheduleNextSweep = async (): Promise<void> => {
    if (!worker || stopping) return;
    let retryAt: Date | null = null;
    try {
      retryAt = await worker.nextWakeAt();
    } catch (error: unknown) {
      entrypointLogger.error({ error }, "Worker sweep scheduling failed");
    }
    const periodicAt =
      configuration.WORKER_SWEEP_INTERVAL_MINUTES > 0
        ? now() + configuration.WORKER_SWEEP_INTERVAL_MINUTES * 60_000
        : undefined;
    const retryTime = retryAt?.getTime();
    const nextAt =
      retryTime === undefined
        ? periodicAt
        : periodicAt === undefined
          ? retryTime
          : Math.min(retryTime, periodicAt);
    if (nextAt === undefined || stopping) return;
    clearSweepTimer();
    sweepTimer = scheduleTimeout(
      () => {
        sweepTimer = undefined;
        void triggerSweep();
      },
      Math.max(0, nextAt - now()),
    );
  };

  const triggerSweep = (): Promise<void> => {
    if (!worker || stopping) return Promise.resolve();
    clearSweepTimer();
    sweepRequested = true;
    if (triggerPromise) return triggerPromise;
    triggerPromise = (async () => {
      while (!stopping) {
        while (sweepRequested && !stopping) {
          sweepRequested = false;
          try {
            await worker?.wake();
          } catch (error: unknown) {
            entrypointLogger.error({ error }, "Worker sweep failed");
          }
        }
        if (stopping) break;
        try {
          await scheduleNextSweep();
        } catch (error: unknown) {
          entrypointLogger.error({ error }, "Worker sweep scheduling failed");
        }
        if (!sweepRequested) break;
        clearSweepTimer();
      }
    })().finally(() => {
      triggerPromise = undefined;
    });
    return triggerPromise;
  };
  try {
    worker = (dependencies.createWorker ?? createWorker)({
      adapters: dependencies.adapters,
      workerId: configuration.WORKER_ID,
      defaultAdapterFactory: dependencies.defaultAdapterFactory,
    });
    await worker.start();
    if (configuration.WORKER_WAKE_URL) {
      wakeServer = (dependencies.createWakeServer ?? createWorkerWakeServer)({
        url: configuration.WORKER_WAKE_URL,
        wake: triggerSweep,
        logger: entrypointLogger,
      });
      await wakeServer.start();
      void triggerSweep();
    }
  } catch (error: unknown) {
    stopping = true;
    clearSweepTimer();
    await cleanupLifecycle(
      [
        async () => wakeServer?.stop(),
        async () => {
          try {
            await worker?.stop();
          } catch (cleanupError: unknown) {
            if (cleanupError !== error) throw cleanupError;
          }
        },
        databaseClose,
      ],
      capturedFailure(error),
    );
    throw error;
  }

  const activeWorker = worker;
  let closePromise: Promise<void> | undefined;
  let uninstallShutdown = (): void => undefined;
  const cleanupOwnedResources = (primaryFailure: Failure = noFailure) => {
    stopping = true;
    clearSweepTimer();
    return cleanupLifecycle(
      [
        uninstallShutdown,
        async () => wakeServer?.stop(),
        activeWorker.stop,
        databaseClose,
      ],
      primaryFailure,
    );
  };
  const close = (): Promise<void> => {
    closePromise ??= cleanupOwnedResources();
    return closePromise;
  };
  try {
    uninstallShutdown = (
      dependencies.installGracefulShutdown ?? installGracefulShutdown
    )(close);

    entrypointLogger.info(
      {
        service: "centsible-api",
        role: "worker",
        revision: dependencies.revision ?? process.env.GIT_SHA ?? "unknown",
      },
      "Worker started",
    );
  } catch (error: unknown) {
    await cleanupOwnedResources(capturedFailure(error));
    throw error;
  }

  return { worker: activeWorker, close, uninstallShutdown };
}
