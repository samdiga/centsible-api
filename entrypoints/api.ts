import { pathToFileURL } from "node:url";
import { logger } from "../src/platform/logging/logger.js";
import {
  startApi,
  type ApiRuntime,
  type ApiStartDependencies,
} from "../src/entrypoints/api.js";

export * from "../src/entrypoints/api.js";

/** Runs the API lifecycle through the sole executable driver layer. */
export function runApiDriver(
  dependencies: ApiStartDependencies = {},
): Promise<ApiRuntime> {
  return startApi(dependencies);
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined &&
    import.meta.url === pathToFileURL(entrypoint).href
  );
}

if (isDirectExecution()) {
  void runApiDriver().catch((error) => {
    logger.error({ err: error }, "API startup failed");
    process.exitCode = 1;
  });
}
