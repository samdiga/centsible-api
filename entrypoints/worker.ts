import { pathToFileURL } from "node:url";
import { logger } from "../src/platform/logging/logger.js";

export * from "../src/entrypoints/worker.js";

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined &&
    import.meta.url === pathToFileURL(entrypoint).href
  );
}

if (isDirectExecution()) {
  void import("../src/entrypoints/worker.js")
    .then(({ startWorker }) => startWorker())
    .catch((error: unknown) => {
      logger.error({ err: error }, "Worker startup failed");
      process.exitCode = 1;
    });
}
