import { pathToFileURL } from "node:url";
import { logger } from "../src/platform/logging/logger.js";

export * from "../src/entrypoints/api.js";

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined &&
    import.meta.url === pathToFileURL(entrypoint).href
  );
}

if (isDirectExecution()) {
  void import("../src/entrypoints/api.js")
    .then(({ startApi }) => startApi())
    .catch((error: unknown) => {
      logger.error({ err: error }, "API startup failed");
      process.exitCode = 1;
    });
}
