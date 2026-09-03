export type WorkerAdapter = {
  enabled?: boolean | undefined;
  start?: (() => void | Promise<void>) | undefined;
  stop?: (() => void | Promise<void>) | undefined;
};

export type WorkerDependencies = {
  adapters?: readonly WorkerAdapter[] | undefined;
};

export type WorkerRuntime = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

/** Builds a worker lifecycle shell without scheduling work or installing process handlers. */
export function createWorker(
  dependencies: WorkerDependencies = {},
): WorkerRuntime {
  const adapters = dependencies.adapters ?? [];
  const started: WorkerAdapter[] = [];
  let stopRequested = false;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let cleanupPromise: Promise<void> | undefined;

  const cleanup = (primaryFailure?: unknown): Promise<void> => {
    cleanupPromise ??= (async () => {
      let firstStopFailure: unknown;
      for (const adapter of [...started].reverse()) {
        try {
          await adapter.stop?.();
        } catch (error: unknown) {
          firstStopFailure ??= error;
        }
      }
      started.length = 0;

      if (primaryFailure !== undefined) throw primaryFailure;
      if (firstStopFailure !== undefined) throw firstStopFailure;
    })();
    return cleanupPromise;
  };

  const start = (): Promise<void> => {
    if (startPromise) return startPromise;
    if (stopRequested) return stopPromise ?? Promise.resolve();
    startPromise = (async () => {
      try {
        for (const adapter of adapters) {
          if (stopRequested) return;
          if (!adapter.enabled) continue;
          await adapter.start?.();
          started.push(adapter);
        }
      } catch (error: unknown) {
        stopRequested = true;
        await cleanup(error);
      }
    })();
    return startPromise;
  };

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopRequested = true;
    stopPromise = (async () => {
      let startFailure: unknown;
      try {
        await startPromise;
      } catch (error: unknown) {
        startFailure = error;
      }
      await cleanup(startFailure);
    })();
    return stopPromise;
  };

  return { start, stop };
}
