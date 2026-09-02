/** A canonical, user-scoped identity for a private cacheable GET response. */
export type CacheKey = Readonly<{
  userId: string;
  method: "GET";
  route: string;
  query: Readonly<Record<string, readonly string[]>>;
  revision: bigint;
  algorithmVersion?: string | undefined;
  horizon?: string | undefined;
  date?: string | undefined;
  timezone?: string | undefined;
}>;

export type CachePolicyInput = Readonly<{
  method: string;
  route: string;
  status?: number | undefined;
  isError?: boolean | undefined;
}>;

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Normalizes a route so semantically equivalent paths share one cache key. */
export function normalizeCacheRoute(route: string): string {
  const pathname = route.split(/[?#]/, 1)[0]?.trim() ?? "";
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  const withoutTrailingSlash = collapsed.replace(/\/+$/, "");
  if (!withoutTrailingSlash) return "/";
  return withoutTrailingSlash.startsWith("/")
    ? withoutTrailingSlash
    : `/${withoutTrailingSlash}`;
}

/** Serializes a cache key with stable route, query, optional-field, and revision ordering. */
export function serializeCacheKey(key: CacheKey): string {
  const query = Object.entries(key.query)
    .map(
      ([name, values]) =>
        [name, [...values].sort(compareStrings)] as [string, string[]],
    )
    .sort(([left], [right]) => compareStrings(left, right));

  return JSON.stringify({
    userId: key.userId,
    method: key.method,
    route: normalizeCacheRoute(key.route),
    query,
    revision: key.revision.toString(),
    algorithmVersion: key.algorithmVersion ?? null,
    horizon: key.horizon ?? null,
    date: key.date ?? null,
    timezone: key.timezone ?? null,
  });
}

/**
 * Returns whether a response is eligible for this explicit private-response
 * cache policy. Route integration is intentionally left to runtime composition.
 */
export function isCacheableResponse(input: CachePolicyInput): boolean {
  if (input.method !== "GET" || input.isError) return false;
  if (input.status !== undefined && input.status >= 400) return false;

  const route = normalizeCacheRoute(input.route);
  const excludedRoutes = ["/auth", "/docs", "/health", "/openapi", "/swagger"];
  return !excludedRoutes.some(
    (excludedRoute) =>
      route === excludedRoute ||
      route.startsWith(`${excludedRoute}/`) ||
      (excludedRoute === "/openapi" && route === "/openapi.json"),
  );
}
