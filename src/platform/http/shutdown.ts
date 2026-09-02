import { logger } from "../logging/logger.js";

/** Register idempotent SIGTERM/SIGINT cleanup and return an unregister function. */
export function installGracefulShutdown(
  close: () => Promise<void>,
): () => void {
  let closing: Promise<void> | undefined;

  const handleSignal = (): void => {
    closing ??= Promise.resolve()
      .then(close)
      .catch((error: unknown) => {
        logger.error({ err: error }, "Graceful shutdown failed");
      });
  };

  process.on("SIGTERM", handleSignal);
  process.on("SIGINT", handleSignal);

  let unregistered = false;
  return () => {
    if (unregistered) return;
    unregistered = true;
    process.off("SIGTERM", handleSignal);
    process.off("SIGINT", handleSignal);
  };
}
