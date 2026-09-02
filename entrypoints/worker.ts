import { pathToFileURL } from "node:url";
import { logger } from "../src/platform/logging/logger.js";
import {
  startWorker,
  type WorkerEntrypointRuntime,
  type WorkerStartDependencies,
} from "../src/entrypoints/worker.js";

export * from "../src/entrypoints/worker.js";

/** Runs the worker lifecycle through the sole executable driver layer. */
export function runWorkerDriver(
  dependencies: WorkerStartDependencies = {},
): Promise<WorkerEntrypointRuntime> {
  return startWorker(dependencies);
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined &&
    import.meta.url === pathToFileURL(entrypoint).href
  );
}

if (isDirectExecution()) {
  void runWorkerDriver().catch((error: unknown) => {
    logger.error({ err: error }, "Worker startup failed");
    process.exitCode = 1;
  });
}
