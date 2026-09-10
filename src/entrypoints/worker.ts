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

/** Starts only the worker role and wires its process-owned shutdown lifecycle. */
export async function startWorker(
  dependencies: WorkerStartDependencies = {},
): Promise<WorkerEntrypointRuntime> {
  const configuration = (dependencies.loadEnv ?? loadEnv)();
  const worker = (dependencies.createWorker ?? createWorker)({
    adapters: dependencies.adapters,
    workerId: configuration.WORKER_ID,
    defaultAdapterFactory: dependencies.defaultAdapterFactory,
  });
  await worker.start();

  const databaseClose = dependencies.closeDb ?? closeDb;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      await worker.stop();
      await databaseClose();
    })();
    return closePromise;
  };
  const uninstallShutdown = (
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

  return { worker, close, uninstallShutdown };
}
