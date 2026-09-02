import { serve, type ServerType } from "@hono/node-server";
import { pathToFileURL } from "node:url";
import {
  createHttpApp,
  type HttpAppDependencies,
} from "../app/create-http-app.js";
import { loadEnv, type Env } from "../platform/config/env.js";
import { closeDb } from "../platform/database/client.js";
import { installGracefulShutdown } from "../platform/http/shutdown.js";
import { logger } from "../platform/logging/logger.js";

type EntrypointLogger = {
  info: (bindings: Record<string, unknown>, message: string) => unknown;
  error: (bindings: Record<string, unknown>, message: string) => unknown;
};

export type ApiStartDependencies = HttpAppDependencies & {
  loadEnv?: (() => Env) | undefined;
  createHttpApp?: typeof createHttpApp | undefined;
  serve?: typeof serve | undefined;
  closeDb?: (() => Promise<void>) | undefined;
  installGracefulShutdown?: typeof installGracefulShutdown | undefined;
  startupLogger?: EntrypointLogger | undefined;
  revision?: string | undefined;
};

export type ApiRuntime = {
  server: ServerType;
  close: () => Promise<void>;
  uninstallShutdown: () => void;
};

function isAlreadyClosed(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ERR_SERVER_NOT_RUNNING"
  );
}

/** Awaits a Node server close, including the normal already-closed case. */
export async function closeServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const complete = (error?: Error): void => {
      if (error && !isAlreadyClosed(error)) {
        reject(error);
        return;
      }
      resolve();
    };

    try {
      server.close(complete);
    } catch (error) {
      if (isAlreadyClosed(error)) {
        resolve();
        return;
      }
      reject(error);
    }
  });
}

/** Starts only the HTTP role and wires its process-owned shutdown lifecycle. */
export function startApi(dependencies: ApiStartDependencies = {}): ApiRuntime {
  const configuration = (dependencies.loadEnv ?? loadEnv)();
  const app = (dependencies.createHttpApp ?? createHttpApp)(dependencies);
  const server = (dependencies.serve ?? serve)({
    fetch: app.fetch,
    port: configuration.PORT,
  });
  const databaseClose = dependencies.closeDb ?? closeDb;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      await closeServer(server);
      await databaseClose();
    })();
    return closePromise;
  };
  const uninstallShutdown = (
    dependencies.installGracefulShutdown ?? installGracefulShutdown
  )(close);

  (dependencies.startupLogger ?? logger).info(
    {
      service: "centsible-api",
      role: "api",
      port: configuration.PORT,
      revision: dependencies.revision ?? process.env.GIT_SHA ?? "unknown",
    },
    "API listening",
  );

  return { server, close, uninstallShutdown };
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined &&
    import.meta.url === pathToFileURL(entrypoint).href
  );
}

if (isDirectExecution()) {
  try {
    startApi();
  } catch (error) {
    logger.error({ err: error }, "API startup failed");
    process.exitCode = 1;
  }
}
