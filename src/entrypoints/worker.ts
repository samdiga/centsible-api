import {
  createWorker,
  type WorkerDependencies,
  type WorkerRuntime,
} from "../app/create-worker.js";
import { loadEnv, type Env } from "../platform/config/env.js";
import { closeDb } from "../platform/database/client.js";
import { installGracefulShutdown } from "../platform/http/shutdown.js";
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
  let worker: WorkerRuntime | undefined;
  try {
    worker = (dependencies.createWorker ?? createWorker)({
      adapters: dependencies.adapters,
      workerId: configuration.WORKER_ID,
      defaultAdapterFactory: dependencies.defaultAdapterFactory,
    });
    await worker.start();
  } catch (error: unknown) {
    await cleanupLifecycle(
      [
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
  const cleanupOwnedResources = (primaryFailure: Failure = noFailure) =>
    cleanupLifecycle(
      [uninstallShutdown, activeWorker.stop, databaseClose],
      primaryFailure,
    );
  const close = (): Promise<void> => {
    closePromise ??= cleanupOwnedResources();
    return closePromise;
  };
  try {
    uninstallShutdown = (
      dependencies.installGracefulShutdown ?? installGracefulShutdown
    )(close);

    (dependencies.logger ?? logger).info(
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
