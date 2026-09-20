import { createDefaultWorkerAdapters } from "./default-worker-adapters.js";

export type WorkerAdapter = {
  enabled?: boolean | undefined;
  start?: (() => void | Promise<void>) | undefined;
  sweep?: (() => void | Promise<void>) | undefined;
  nextWakeAt?: (() => Promise<Date | null>) | undefined;
  stop?: (() => void | Promise<void>) | undefined;
};

export type WorkerDependencies = {
  adapters?: readonly WorkerAdapter[] | undefined;
  workerId?: string | undefined;
  defaultAdapterFactory?:
    ((workerId: string) => readonly WorkerAdapter[]) | undefined;
};

export type WorkerRuntime = {
  start: () => Promise<void>;
  wake: () => Promise<void>;
  nextWakeAt: () => Promise<Date | null>;
  stop: () => Promise<void>;
};

type Failure =
  Readonly<{ present: false }> | Readonly<{ present: true; value: unknown }>;

const noFailure: Failure = { present: false };

function capturedFailure(value: unknown): Failure {
  return { present: true, value };
}

/** Builds a worker lifecycle shell without scheduling work or installing process handlers. */
export function createWorker(
  dependencies: WorkerDependencies = {},
): WorkerRuntime {
  const adapters =
    dependencies.adapters ??
    (dependencies.workerId
      ? (dependencies.defaultAdapterFactory ?? createDefaultWorkerAdapters)(
          dependencies.workerId,
        )
      : []);
  const started: WorkerAdapter[] = [];
  let stopRequested = false;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let wakePromise: Promise<void> | undefined;

  const cleanup = (primaryFailure: Failure = noFailure): Promise<void> => {
    cleanupPromise ??= (async () => {
      const failures: unknown[] = [];
      if (primaryFailure.present) failures.push(primaryFailure.value);
      for (const adapter of [...started].reverse()) {
        try {
          await adapter.stop?.();
        } catch (error: unknown) {
          failures.push(error);
        }
      }
      started.length = 0;

      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Worker adapter cleanup failed");
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
          started.push(adapter);
          await adapter.start?.();
        }
      } catch (error: unknown) {
        stopRequested = true;
        await cleanup(capturedFailure(error));
      }
    })();
    return startPromise;
  };

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopRequested = true;
    stopPromise = (async () => {
      let startFailure: Failure = noFailure;
      try {
        await startPromise;
      } catch (error: unknown) {
        startFailure = capturedFailure(error);
      }
      await cleanup(startFailure);
    })();
    return stopPromise;
  };

  const wake = (): Promise<void> => {
    if (!startPromise || stopRequested) return Promise.resolve();
    if (wakePromise) return wakePromise;
    wakePromise = (async () => {
      await startPromise;
      if (stopRequested) return;
      for (const adapter of started) {
        if (stopRequested) return;
        await adapter.sweep?.();
      }
    })().finally(() => {
      wakePromise = undefined;
    });
    return wakePromise;
  };

  const nextWakeAt = async (): Promise<Date | null> => {
    if (!startPromise || stopRequested) return null;
    await startPromise;
    const deadlines = await Promise.all(
      started.map((adapter) => adapter.nextWakeAt?.() ?? Promise.resolve(null)),
    );
    return deadlines.reduce<Date | null>((earliest, value) => {
      if (!value) return earliest;
      return !earliest || value < earliest ? value : earliest;
    }, null);
  };

  return { start, wake, nextWakeAt, stop };
}
