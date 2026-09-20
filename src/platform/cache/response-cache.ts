import { LRUCache } from "lru-cache";
import { serializeCacheKey, type CacheKey } from "./cache-policy.js";

/** Conservative fixed bookkeeping allowance included in every cache entry. */
export const CACHE_ENTRY_OVERHEAD_BYTES = 256;
/** No response value larger than this is ever retained, regardless of configuration. */
export const MAX_CACHE_ENTRY_BYTES = 2 * 1024 * 1024;

const DEFAULT_TTL_MS = 300_000;
const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export type CacheClock = Readonly<{
  now: () => number;
}>;

export type ResponseCacheOptions = Readonly<{
  clock?: CacheClock | undefined;
  ttlMs?: number | undefined;
  maxEntries?: number | undefined;
  maxBytes?: number | undefined;
  maxEntryBytes?: number | undefined;
  setInterval?:
    ((callback: () => void, milliseconds: number) => unknown) | undefined;
  clearInterval?: ((handle: unknown) => void) | undefined;
}>;

export type ResponseCacheStats = Readonly<{
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
  maxEntryBytes: number;
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
  coalesced: number;
  ttlExpirations: number;
  lruEvictions: number;
  byteEvictions: number;
  userInvalidations: number;
  userEntriesInvalidated: number;
  rejectedOversize: number;
  rejectedNonSerializable: number;
}>;

export type ResponseCache = Readonly<{
  getOrCompute: <T>(key: CacheKey, compute: () => Promise<T>) => Promise<T>;
  invalidateUser: (userId: string) => void;
  invalidateAllUsers: (exceptUserId?: string) => void;
  purgeExpired: () => void;
  startCleanup: (intervalMs?: number) => () => void;
  stats: () => ResponseCacheStats;
}>;

/** Returns a cache-compatible pass-through for low-traffic deployments. */
export function createDisabledResponseCache(): ResponseCache {
  let misses = 0;
  return {
    async getOrCompute<T>(
      _key: CacheKey,
      compute: () => Promise<T>,
    ): Promise<T> {
      misses += 1;
      return compute();
    },
    invalidateUser: () => undefined,
    invalidateAllUsers: () => undefined,
    purgeExpired: () => undefined,
    startCleanup: () => () => undefined,
    stats: () => ({
      ttlMs: 0,
      maxEntries: 0,
      maxBytes: 0,
      maxEntryBytes: 0,
      entries: 0,
      bytes: 0,
      hits: 0,
      misses,
      coalesced: 0,
      ttlExpirations: 0,
      lruEvictions: 0,
      byteEvictions: 0,
      userInvalidations: 0,
      userEntriesInvalidated: 0,
      rejectedOversize: 0,
      rejectedNonSerializable: 0,
    }),
  };
}

type CacheEntry = Readonly<{
  value: unknown;
  userId: string;
  createdAt: number;
  expiresAt: number;
  payloadBytes: number;
}>;

type InFlight = Readonly<{
  userId: string;
  epoch: number;
  promise: Promise<unknown>;
}>;

type RemovalContext = "ttl" | "user";
type EvictionPressure = "byte" | "count";

function defaultClock(): CacheClock {
  return { now: () => globalThis.performance.now() };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

/**
 * Creates an explicit, user-scoped private response cache. Construction does
 * not schedule cleanup or start any database/listener resources.
 */
export function createResponseCache(
  options: ResponseCacheOptions = {},
): ResponseCache {
  const clock = options.clock ?? defaultClock();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEntryBytes = Math.min(
    options.maxEntryBytes ?? MAX_CACHE_ENTRY_BYTES,
    MAX_CACHE_ENTRY_BYTES,
    maxBytes,
  );
  assertPositiveInteger("ttlMs", ttlMs);
  assertPositiveInteger("maxEntries", maxEntries);
  assertPositiveInteger("maxBytes", maxBytes);
  assertPositiveInteger("maxEntryBytes", maxEntryBytes);

  const userKeys = new Map<string, Set<string>>();
  const observedRevisions = new Map<string, bigint>();
  const invalidationEpochs = new Map<string, number>();
  const inFlight = new Map<string, InFlight>();
  const removalContexts = new Map<string, RemovalContext>();
  let pendingEvictionPressure: EvictionPressure | undefined;
  let cleanupHandle: unknown;
  let activeStop: (() => void) | undefined;
  const counters = {
    hits: 0,
    misses: 0,
    coalesced: 0,
    ttlExpirations: 0,
    lruEvictions: 0,
    byteEvictions: 0,
    userInvalidations: 0,
    userEntriesInvalidated: 0,
    rejectedOversize: 0,
    rejectedNonSerializable: 0,
  };

  const lru = new LRUCache<string, CacheEntry>({
    max: maxEntries,
    maxSize: maxBytes,
    maxEntrySize: maxEntryBytes,
    ttl: ttlMs,
    ttlResolution: 0,
    ttlAutopurge: false,
    updateAgeOnGet: false,
    updateAgeOnHas: false,
    noUpdateTTL: true,
    perf: clock,
    sizeCalculation: (entry, serializedKey) =>
      entry.payloadBytes +
      utf8Bytes(serializedKey) +
      CACHE_ENTRY_OVERHEAD_BYTES,
    disposeAfter: (entry, serializedKey, reason) => {
      const removalContext = removalContexts.get(serializedKey);
      removalContexts.delete(serializedKey);
      if (reason === "evict") {
        if (pendingEvictionPressure === "byte") {
          counters.byteEvictions += 1;
        } else {
          counters.lruEvictions += 1;
        }
      } else if (reason === "expire" || removalContext === "ttl") {
        counters.ttlExpirations += 1;
      }

      // A replacement disposes the old value after the new value exists. Do
      // not remove that new value's index entry.
      if (!lru.has(serializedKey)) {
        const keys = userKeys.get(entry.userId);
        keys?.delete(serializedKey);
        if (keys?.size === 0) userKeys.delete(entry.userId);
      }
    },
  });

  const currentEpoch = (userId: string): number =>
    invalidationEpochs.get(userId) ?? 0;

  const deleteEntry = (
    serializedKey: string,
    context: RemovalContext,
  ): boolean => {
    removalContexts.set(serializedKey, context);
    const deleted = lru.delete(serializedKey);
    if (!deleted) removalContexts.delete(serializedKey);
    return deleted;
  };

  const addToUserIndex = (userId: string, serializedKey: string): void => {
    let keys = userKeys.get(userId);
    if (!keys) {
      keys = new Set<string>();
      userKeys.set(userId, keys);
    }
    keys.add(serializedKey);
  };

  const invalidateUser = (userId: string): void => {
    counters.userInvalidations += 1;
    invalidationEpochs.set(userId, currentEpoch(userId) + 1);

    const keys = [...(userKeys.get(userId) ?? [])];
    for (const serializedKey of keys) {
      if (deleteEntry(serializedKey, "user")) {
        counters.userEntriesInvalidated += 1;
      }
    }
    userKeys.delete(userId);

    for (const [serializedKey, flight] of inFlight) {
      if (flight.userId === userId) inFlight.delete(serializedKey);
    }
  };

  /** Evicts every user's cached data, optionally preserving one writer's entry. */
  const invalidateAllUsers = (exceptUserId?: string): void => {
    const userIds = new Set<string>(userKeys.keys());
    for (const flight of inFlight.values()) userIds.add(flight.userId);
    for (const userId of userIds) {
      if (userId !== exceptUserId) invalidateUser(userId);
    }
  };

  const recordObservedRevision = (key: CacheKey): void => {
    const previousRevision = observedRevisions.get(key.userId);
    if (previousRevision !== undefined && previousRevision !== key.revision) {
      invalidateUser(key.userId);
    }
    observedRevisions.set(key.userId, key.revision);
  };

  const tryStore = (
    key: CacheKey,
    serializedKey: string,
    value: unknown,
    epoch: number,
  ): void => {
    if (epoch !== currentEpoch(key.userId)) return;

    let serializedPayload: string | undefined;
    try {
      const serialized = JSON.stringify(value);
      if (typeof serialized === "string") serializedPayload = serialized;
    } catch {
      counters.rejectedNonSerializable += 1;
      return;
    }
    if (serializedPayload === undefined) {
      counters.rejectedNonSerializable += 1;
      return;
    }

    const payloadBytes = utf8Bytes(serializedPayload);
    const totalBytes =
      payloadBytes + utf8Bytes(serializedKey) + CACHE_ENTRY_OVERHEAD_BYTES;
    if (totalBytes > maxEntryBytes || totalBytes > maxBytes) {
      counters.rejectedOversize += 1;
      return;
    }

    const existing = lru.peek(serializedKey);
    const existingBytes = existing
      ? existing.payloadBytes +
        utf8Bytes(serializedKey) +
        CACHE_ENTRY_OVERHEAD_BYTES
      : 0;
    const projectedBytes = lru.calculatedSize - existingBytes + totalBytes;
    pendingEvictionPressure =
      projectedBytes > maxBytes
        ? "byte"
        : existing === undefined && lru.size >= maxEntries
          ? "count"
          : undefined;
    try {
      const createdAt = clock.now();
      lru.set(serializedKey, {
        value,
        userId: key.userId,
        createdAt,
        expiresAt: createdAt + ttlMs,
        payloadBytes,
      });
    } finally {
      pendingEvictionPressure = undefined;
    }
    if (lru.has(serializedKey)) addToUserIndex(key.userId, serializedKey);
  };

  const waitForFlight = async <T>(
    serializedKey: string,
    flight: InFlight,
  ): Promise<T> => {
    try {
      return (await flight.promise) as T;
    } finally {
      if (inFlight.get(serializedKey) === flight) {
        inFlight.delete(serializedKey);
      }
    }
  };

  const getOrCompute = <T>(
    key: CacheKey,
    compute: () => Promise<T>,
  ): Promise<T> => {
    recordObservedRevision(key);
    const serializedKey = serializeCacheKey(key);
    const cached = lru.peek(serializedKey);
    if (cached) {
      if (clock.now() >= cached.expiresAt) {
        deleteEntry(serializedKey, "ttl");
      } else {
        const touched = lru.get(serializedKey);
        if (touched) {
          counters.hits += 1;
          return Promise.resolve(touched.value as T);
        }
      }
    } else {
      // lru-cache's peek intentionally leaves a library-stale item in place.
      // Remove it before same-key storage so noUpdateTTL cannot retain its TTL.
      lru.get(serializedKey);
    }

    const existingFlight = inFlight.get(serializedKey);
    if (existingFlight) {
      counters.coalesced += 1;
      return waitForFlight<T>(serializedKey, existingFlight);
    }

    counters.misses += 1;
    const epoch = currentEpoch(key.userId);
    let resolveWork: ((value: T) => void) | undefined;
    let rejectWork: ((reason: unknown) => void) | undefined;
    const work = new Promise<T>((resolve, reject) => {
      resolveWork = resolve;
      rejectWork = reject;
    });
    const flight: InFlight = { userId: key.userId, epoch, promise: work };
    inFlight.set(serializedKey, flight);

    try {
      Promise.resolve(compute()).then(
        (value) => {
          tryStore(key, serializedKey, value, epoch);
          resolveWork?.(value);
        },
        (error: unknown) => rejectWork?.(error),
      );
    } catch (error: unknown) {
      rejectWork?.(error);
    }

    return waitForFlight<T>(serializedKey, flight);
  };

  const purgeExpired = (): void => {
    const now = clock.now();
    for (const [serializedKey, entry] of lru.entries()) {
      if (entry.expiresAt <= now) deleteEntry(serializedKey, "ttl");
    }
    lru.purgeStale();
  };

  const startCleanup = (intervalMs = 60_000): (() => void) => {
    assertPositiveInteger("cleanup interval", intervalMs);
    if (activeStop) return activeStop;

    const schedule =
      options.setInterval ??
      ((callback: () => void, milliseconds: number): unknown =>
        globalThis.setInterval(callback, milliseconds));
    const cancel =
      options.clearInterval ??
      ((handle: unknown): void =>
        globalThis.clearInterval(handle as ReturnType<typeof setInterval>));
    const handle = schedule(purgeExpired, intervalMs);
    cleanupHandle = handle;
    (handle as { unref?: () => void } | null)?.unref?.();
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      if (cleanupHandle === handle) {
        cancel(handle);
        cleanupHandle = undefined;
        activeStop = undefined;
      }
    };
    activeStop = stop;
    return stop;
  };

  return {
    getOrCompute,
    invalidateUser,
    invalidateAllUsers,
    purgeExpired,
    startCleanup,
    stats: (): ResponseCacheStats => ({
      ttlMs,
      maxEntries,
      maxBytes,
      maxEntryBytes,
      entries: lru.size,
      bytes: lru.calculatedSize,
      ...counters,
    }),
  };
}
