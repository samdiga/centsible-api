import { createServer, type Server } from "node:http";

type WakeLogger = Readonly<{
  error: (bindings: Record<string, unknown>, message: string) => unknown;
}>;

export type WorkerWakeServer = Readonly<{
  start: () => Promise<string>;
  stop: () => Promise<void>;
}>;

type WakeServerOptions = Readonly<{
  url: string;
  wake: () => void | Promise<void>;
  logger: WakeLogger;
  createServerFn?: typeof createServer;
}>;

/** Exposes a loopback-only signal that starts a worker sweep. */
export function createWorkerWakeServer(
  options: WakeServerOptions,
): WorkerWakeServer {
  const configured = new URL(options.url);
  const hostname =
    configured.hostname === "[::1]" ? "::1" : configured.hostname;
  const requestedPort = Number(configured.port);
  const create = options.createServerFn ?? createServer;
  let server: Server | undefined;
  let address: string | undefined;
  let startPromise: Promise<string> | undefined;
  let stopPromise: Promise<void> | undefined;

  const start = (): Promise<string> => {
    if (startPromise) return startPromise;
    startPromise = new Promise<string>((resolve, reject) => {
      const active = create((request, response) => {
        const requestUrl = new URL(request.url ?? "/", configured.origin);
        if (requestUrl.pathname !== configured.pathname) {
          response.statusCode = 404;
          response.end();
          return;
        }
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.setHeader("allow", "POST");
          response.end();
          return;
        }
        response.statusCode = 202;
        response.end();
        void Promise.resolve()
          .then(options.wake)
          .catch((error: unknown) =>
            options.logger.error({ error }, "worker wake failed"),
          );
      });
      server = active;
      const fail = (error: Error): void => {
        active.off("listening", ready);
        reject(error);
      };
      const ready = (): void => {
        active.off("error", fail);
        const bound = active.address();
        if (!bound || typeof bound === "string") {
          reject(new Error("Worker wake server did not bind TCP"));
          return;
        }
        const displayHost = hostname.includes(":") ? `[${hostname}]` : hostname;
        address = `http://${displayHost}:${bound.port}${configured.pathname}`;
        resolve(address);
      };
      active.once("error", fail);
      active.once("listening", ready);
      active.listen(requestedPort, hostname);
    });
    return startPromise;
  };

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
    })();
    return stopPromise;
  };

  return { start, stop };
}

type WakeClientOptions = Readonly<{
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}>;

/** Sends one bounded loopback wake request after durable work is queued. */
export function createWorkerWakeClient(
  url: string,
  options: WakeClientOptions = {},
): () => Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("timeoutMs must be a positive integer");
  const fetchFn = options.fetchFn ?? fetch;

  return async () => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Worker wake request timed out")),
      timeoutMs,
    );
    try {
      const response = await fetchFn(url, {
        method: "POST",
        signal: controller.signal,
      });
      if (response.status !== 202)
        throw new Error(
          `Worker wake request failed with status ${response.status}`,
        );
    } finally {
      clearTimeout(timeout);
    }
  };
}
