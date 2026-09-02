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
  let startedOnce = false;
  let stopped = false;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  const start = async (): Promise<void> => {
    if (stopped || startedOnce) return startPromise;
    startedOnce = true;
    startPromise = (async () => {
      for (const adapter of adapters) {
        if (stopped) return;
        if (!adapter.enabled) continue;
        await adapter.start?.();
        started.push(adapter);
      }
    })();
    return startPromise;
  };

  const stop = async (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopped = true;
    stopPromise = (async () => {
      await startPromise;
      for (const adapter of [...started].reverse()) {
        await adapter.stop?.();
      }
    })();
    return stopPromise;
  };

  return { start, stop };
}
