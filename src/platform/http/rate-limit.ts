import { RateLimitError } from "../errors/app-error.js";

export type TokenBucketConfig = Readonly<{
  capacity: number;
  refillPerMinute: number;
}>;

type Bucket = {
  tokens: number;
  refilledAt: number;
  lastSeen: number;
};

const buckets = new Map<string, Bucket>();
const STALE_BUCKET_MS = 10 * 60_000;
const MAX_BUCKETS_BEFORE_SWEEP = 10_000;

function validateConfig(config: TokenBucketConfig): void {
  if (
    !Number.isSafeInteger(config.capacity) ||
    config.capacity <= 0 ||
    !Number.isFinite(config.refillPerMinute) ||
    config.refillPerMinute < 0
  ) {
    throw new Error("Invalid token bucket configuration");
  }
}

/** Consumes one token from a process-local, independently keyed bucket. */
export function consumeToken(key: string, config: TokenBucketConfig): void {
  validateConfig(config);
  const now = Date.now();
  if (buckets.size > MAX_BUCKETS_BEFORE_SWEEP) {
    for (const [bucketKey, bucket] of buckets) {
      if (now - bucket.lastSeen > STALE_BUCKET_MS) buckets.delete(bucketKey);
    }
  }
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: config.capacity, refilledAt: now, lastSeen: now };
    buckets.set(key, bucket);
  }
  bucket.lastSeen = now;
  const refilled = Math.floor(
    ((now - bucket.refilledAt) / 60_000) * config.refillPerMinute,
  );
  if (refilled > 0) {
    bucket.tokens = Math.min(config.capacity, bucket.tokens + refilled);
    bucket.refilledAt = now;
  }
  if (bucket.tokens <= 0) throw new RateLimitError();
  bucket.tokens -= 1;
}

/** Clears buckets for deterministic unit tests. */
export function resetTokenBucketsForTests(): void {
  buckets.clear();
}
