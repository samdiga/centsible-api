import { describe, expect, it, vi } from "vitest";
import {
  isCacheableResponse,
  serializeCacheKey,
  type CacheKey,
} from "./cache-policy.js";
import { createResponseCache } from "./response-cache.js";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

class FakeClock {
  #now = 0;

  now = (): number => this.#now;

  advance(milliseconds: number): void {
    this.#now += milliseconds;
  }
}

class FakeIntervals {
  starts = 0;
  stops = 0;
  #nextId = 1;
  #callbacks = new Map<number, () => void>();

  setInterval = (callback: () => void): number => {
    const id = this.#nextId++;
    this.starts += 1;
    this.#callbacks.set(id, callback);
    return id;
  };

  clearInterval = (id: unknown): void => {
    if (typeof id !== "number") return;
    this.stops += 1;
    this.#callbacks.delete(id);
  };

  tick(): void {
    for (const callback of this.#callbacks.values()) callback();
  }
}

function cacheKey(overrides: Partial<CacheKey> = {}): CacheKey {
  return {
    userId: USER_A,
    method: "GET",
    route: "/accounts",
    query: {},
    revision: 0n,
    ...overrides,
  };
}

function entryBytes(key: CacheKey, value: unknown): number {
  const encoder = new TextEncoder();
  const payload = JSON.stringify(value);
  if (typeof payload !== "string") throw new Error("Expected JSON payload");
  return (
    encoder.encode(payload).byteLength +
    encoder.encode(serializeCacheKey(key)).byteLength +
    256
  );
}

describe("cache policy and canonical keys", () => {
  it("serializes equivalent GET keys deterministically with UTF-8-safe revision data", () => {
    const serialized = serializeCacheKey(
      cacheKey({
        route: "accounts///",
        query: { z: ["b", "a"], a: ["2", "1"] },
        revision: 12n,
        algorithmVersion: "v2",
        horizon: "three-months",
        date: "2026-09-02",
        timezone: "America/New_York",
      }),
    );

    expect(serialized).toBe(
      '{"userId":"11111111-1111-4111-8111-111111111111","method":"GET","route":"/accounts","query":[["a",["1","2"]],["z",["a","b"]]],"revision":"12","algorithmVersion":"v2","horizon":"three-months","date":"2026-09-02","timezone":"America/New_York"}',
    );
    expect(
      serializeCacheKey(
        cacheKey({
          route: "/accounts",
          query: { a: ["1", "2"], z: ["a", "b"] },
          revision: 12n,
          algorithmVersion: "v2",
          horizon: "three-months",
          date: "2026-09-02",
          timezone: "America/New_York",
        }),
      ),
    ).toBe(serialized);
  });

  it("only classifies successful non-auth GET data routes as cacheable", () => {
    expect(isCacheableResponse({ method: "GET", route: "/accounts" })).toBe(
      true,
    );
    expect(isCacheableResponse({ method: "POST", route: "/accounts" })).toBe(
      false,
    );
    expect(isCacheableResponse({ method: "GET", route: "/auth/session" })).toBe(
      false,
    );
    expect(isCacheableResponse({ method: "GET", route: "/docs" })).toBe(false);
    expect(isCacheableResponse({ method: "GET", route: "/openapi.json" })).toBe(
      false,
    );
    expect(isCacheableResponse({ method: "GET", route: "/health" })).toBe(
      false,
    );
    expect(
      isCacheableResponse({ method: "GET", route: "/accounts", status: 500 }),
    ).toBe(false);
    expect(
      isCacheableResponse({ method: "GET", route: "/accounts", isError: true }),
    ).toBe(false);
  });
});

describe("ResponseCache", () => {
  it("expires at the exact absolute TTL boundary without sliding on reads", async () => {
    const clock = new FakeClock();
    const cache = createResponseCache({ clock, ttlMs: 300_000 });
    const compute = vi.fn(async () => "first");

    await expect(cache.getOrCompute(cacheKey(), compute)).resolves.toBe(
      "first",
    );
    clock.advance(299_999);
    await expect(
      cache.getOrCompute(cacheKey(), async () => "second"),
    ).resolves.toBe("first");
    clock.advance(1);
    await expect(
      cache.getOrCompute(cacheKey(), async () => "second"),
    ).resolves.toBe("second");

    expect(compute).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({
      hits: 1,
      misses: 2,
      ttlExpirations: 1,
    });
  });

  it("cleans a library-stale key before retaining its same-key recomputation", async () => {
    const clock = new FakeClock();
    const cache = createResponseCache({ clock, ttlMs: 10 });

    clock.advance(1);
    await cache.getOrCompute(cacheKey(), async () => "first");
    clock.advance(11);
    await expect(
      cache.getOrCompute(cacheKey(), async () => "second"),
    ).resolves.toBe("second");
    await expect(
      cache.getOrCompute(cacheKey(), async () => "unexpected"),
    ).resolves.toBe("second");
  });

  it("retains the most recently used entry when the count bound evicts", async () => {
    const cache = createResponseCache({
      maxEntries: 2,
      maxBytes: 10_000,
      maxEntryBytes: 10_000,
    });
    const first = cacheKey({ route: "/first" });
    const second = cacheKey({ route: "/second" });
    const third = cacheKey({ route: "/third" });

    await cache.getOrCompute(first, async () => "first");
    await cache.getOrCompute(second, async () => "second");
    await cache.getOrCompute(first, async () => "wrong");
    await cache.getOrCompute(third, async () => "third");

    expect(cache.stats()).toMatchObject({ entries: 2, lruEvictions: 1 });
    await expect(cache.getOrCompute(first, async () => "wrong")).resolves.toBe(
      "first",
    );
    await expect(
      cache.getOrCompute(second, async () => "second-again"),
    ).resolves.toBe("second-again");
    expect(cache.stats()).toMatchObject({ entries: 2, lruEvictions: 2 });
  });

  it("uses UTF-8 payload and canonical-key bytes when enforcing the byte bound", async () => {
    const first = cacheKey({ route: "/résumé" });
    const second = cacheKey({ route: "/café" });
    const firstValue = { currency: "€" };
    const secondValue = { currency: "¥" };
    const firstBytes = entryBytes(first, firstValue);
    const secondBytes = entryBytes(second, secondValue);
    const cache = createResponseCache({
      maxEntries: 10,
      maxBytes: firstBytes + secondBytes - 1,
      maxEntryBytes: Math.max(firstBytes, secondBytes) + 1,
    });

    await cache.getOrCompute(first, async () => firstValue);
    expect(cache.stats()).toMatchObject({ entries: 1, bytes: firstBytes });
    await cache.getOrCompute(second, async () => secondValue);

    await expect(
      cache.getOrCompute(first, async () => firstValue),
    ).resolves.toEqual(firstValue);
    expect(cache.stats()).toMatchObject({ byteEvictions: 2 });
    expect(cache.stats().bytes).toBeLessThanOrEqual(
      firstBytes + secondBytes - 1,
    );
  });

  it("returns oversize and non-serializable values without retaining them", async () => {
    const cache = createResponseCache({
      maxBytes: 10_000,
      maxEntryBytes: 512,
    });
    const retained = cacheKey({ route: "/retained" });
    const oversize = cacheKey({ route: "/oversize" });
    const nonSerializable = cacheKey({ route: "/non-serializable" });
    const oversizeCompute = vi.fn(async () => "x".repeat(1_000));
    const bigintCompute = vi.fn(async () => 1n);

    await cache.getOrCompute(retained, async () => "retained");
    await expect(
      cache.getOrCompute(oversize, oversizeCompute),
    ).resolves.toHaveLength(1_000);
    await cache.getOrCompute(oversize, oversizeCompute);
    await cache.getOrCompute(nonSerializable, bigintCompute);
    await cache.getOrCompute(nonSerializable, bigintCompute);

    await expect(
      cache.getOrCompute(retained, async () => "unexpected"),
    ).resolves.toBe("retained");
    expect(oversizeCompute).toHaveBeenCalledTimes(2);
    expect(bigintCompute).toHaveBeenCalledTimes(2);
    expect(cache.stats()).toMatchObject({ rejectedOversize: 2, entries: 1 });
  });

  it("coalesces concurrent misses and clears a rejected flight for retry", async () => {
    const cache = createResponseCache();
    const key = cacheKey();
    let resolveFirst: ((value: string) => void) | undefined;
    const firstValue = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const compute = vi.fn(() => firstValue);

    const first = cache.getOrCompute(key, compute);
    const second = cache.getOrCompute(key, compute);
    expect(compute).toHaveBeenCalledTimes(1);
    resolveFirst?.("shared");
    await expect(Promise.all([first, second])).resolves.toEqual([
      "shared",
      "shared",
    ]);

    const rejected = vi.fn(async () => {
      throw new Error("not cached");
    });
    const rejectedKey = cacheKey({ route: "/rejected" });
    await expect(
      Promise.all([
        cache.getOrCompute(rejectedKey, rejected),
        cache.getOrCompute(rejectedKey, rejected),
      ]),
    ).rejects.toThrow("not cached");
    await expect(
      cache.getOrCompute(rejectedKey, async () => "retry"),
    ).resolves.toBe("retry");

    expect(rejected).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ coalesced: 2 });
  });

  it("does not let an invalidated old flight erase a newer flight or repopulate", async () => {
    const cache = createResponseCache();
    const key = cacheKey();
    let resolveOld: ((value: string) => void) | undefined;
    let resolveNew: ((value: string) => void) | undefined;
    const oldValue = new Promise<string>((resolve) => {
      resolveOld = resolve;
    });
    const newValue = new Promise<string>((resolve) => {
      resolveNew = resolve;
    });
    const oldCompute = vi.fn(() => oldValue);
    const newCompute = vi.fn(() => newValue);

    const oldFlight = cache.getOrCompute(key, oldCompute);
    cache.invalidateUser(USER_A);
    const newFlight = cache.getOrCompute(key, newCompute);
    resolveOld?.("old");
    await expect(oldFlight).resolves.toBe("old");

    const joinedNewFlight = cache.getOrCompute(key, newCompute);
    expect(newCompute).toHaveBeenCalledTimes(1);
    resolveNew?.("new");
    await expect(Promise.all([newFlight, joinedNewFlight])).resolves.toEqual([
      "new",
      "new",
    ]);
    await expect(
      cache.getOrCompute(key, async () => "unexpected"),
    ).resolves.toBe("new");
  });

  it("removes a user entry even when lru-cache already considers it stale", async () => {
    const clock = new FakeClock();
    const cache = createResponseCache({ clock, ttlMs: 10 });

    clock.advance(1);
    await cache.getOrCompute(cacheKey(), async () => "first");
    clock.advance(11);
    cache.invalidateUser(USER_A);

    expect(cache.stats()).toMatchObject({
      entries: 0,
      userEntriesInvalidated: 1,
    });
  });

  it("isolates users and drops older revisions before computing a new revision", async () => {
    const cache = createResponseCache();
    const firstUserKey = cacheKey({ route: "/first" });
    const secondUserKey = cacheKey({ route: "/second" });
    const otherUserKey = cacheKey({ userId: USER_B, route: "/other" });

    await cache.getOrCompute(firstUserKey, async () => "first");
    await cache.getOrCompute(secondUserKey, async () => "second");
    await cache.getOrCompute(otherUserKey, async () => "other");
    cache.invalidateUser(USER_A);

    await expect(
      cache.getOrCompute(firstUserKey, async () => "first-new"),
    ).resolves.toBe("first-new");
    await expect(
      cache.getOrCompute(otherUserKey, async () => "wrong"),
    ).resolves.toBe("other");

    const revised = cacheKey({ route: "/first", revision: 1n });
    await expect(
      cache.getOrCompute(revised, async () => "revision-1"),
    ).resolves.toBe("revision-1");
    await expect(
      cache.getOrCompute(firstUserKey, async () => "old-recomputed"),
    ).resolves.toBe("old-recomputed");
    expect(cache.stats()).toMatchObject({ userInvalidations: 3 });
  });

  it("starts no cleanup timer until requested and purges exact-boundary entries", async () => {
    const clock = new FakeClock();
    const timers = new FakeIntervals();
    const cache = createResponseCache({
      clock,
      ttlMs: 10,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });

    expect(timers.starts).toBe(0);
    await cache.getOrCompute(cacheKey(), async () => "first");
    clock.advance(10);
    cache.purgeExpired();
    await expect(
      cache.getOrCompute(cacheKey(), async () => "second"),
    ).resolves.toBe("second");

    const stop = cache.startCleanup(100);
    expect(cache.startCleanup(100)).toBe(stop);
    expect(timers.starts).toBe(1);
    timers.tick();
    stop();
    stop();
    expect(timers.stops).toBe(1);
  });
});
