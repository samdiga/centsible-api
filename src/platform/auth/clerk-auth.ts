import {
  createClerkClient,
  verifyToken as verifyClerkToken,
} from "@clerk/backend";
import type { MiddlewareHandler } from "hono";
import { env } from "../config/env.js";
import { getDb } from "../database/client.js";
import { AuthenticationError } from "../errors/app-error.js";
import type { AppEnv } from "../http/hono-env.js";
import {
  createUserIdentityRepository,
  resolveOrCreateInternalUser,
  type UserIdentity,
  type UserIdentityRepository,
} from "./user-identity.repository.js";

const USER_CACHE_TTL_MS = 5 * 60_000;
const USER_CACHE_MAX = 10_000;

type VerifiedToken = { sub?: string | undefined };
type ClerkClient = {
  users: { getUser: (userId: string) => Promise<UserIdentity> };
};
type ClerkConfiguration = {
  CLERK_SECRET_KEY?: string | undefined;
  CLERK_JWT_KEY?: string | undefined;
};

export type ClerkAuthDependencies = {
  configuration?: () => ClerkConfiguration;
  verifyToken?: (
    token: string,
    options: { secretKey: string; jwtKey?: string | undefined },
  ) => Promise<VerifiedToken>;
  clerkClient?: ClerkClient;
  clerkClientFactory?: (secretKey: string) => ClerkClient;
  repository?: UserIdentityRepository;
};

const userIdCache = new Map<string, { userId: string; expiresAt: number }>();
let runtimeClerkClient: ClerkClient | null | undefined;

function runtimeClient(secretKey: string): ClerkClient {
  runtimeClerkClient ??= createClerkClient({ secretKey });
  return runtimeClerkClient;
}

function cacheUser(clerkUserId: string, userId: string): void {
  if (userIdCache.size >= USER_CACHE_MAX) userIdCache.clear();
  userIdCache.set(clerkUserId, {
    userId,
    expiresAt: Date.now() + USER_CACHE_TTL_MS,
  });
}

/** Clears only process-local auth state; intended for isolated tests. */
export function __resetAuthCachesForTests(): void {
  runtimeClerkClient = undefined;
  userIdCache.clear();
}

export const __resetClerkForTests = __resetAuthCachesForTests;

/** Verifies a Clerk bearer token before resolving its internal user mapping. */
export function clerkAuth(
  dependencies: ClerkAuthDependencies = {},
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authorization = c.req.header("authorization");
    if (!authorization?.startsWith("Bearer ")) throw new AuthenticationError();

    const configuration = dependencies.configuration?.() ?? env();
    if (!configuration.CLERK_SECRET_KEY)
      throw new AuthenticationError("Clerk not configured");

    const token = authorization.slice("Bearer ".length);
    let verified: VerifiedToken;
    try {
      verified = await (dependencies.verifyToken ?? verifyClerkToken)(token, {
        secretKey: configuration.CLERK_SECRET_KEY,
        ...(configuration.CLERK_JWT_KEY
          ? { jwtKey: configuration.CLERK_JWT_KEY }
          : {}),
      });
    } catch {
      throw new AuthenticationError("Invalid token");
    }

    const clerkUserId = verified.sub;
    if (!clerkUserId) throw new AuthenticationError();

    const cached = userIdCache.get(clerkUserId);
    if (cached && cached.expiresAt > Date.now()) {
      c.set("userId", cached.userId);
      c.set("clerkUserId", clerkUserId);
      await next();
      return;
    }

    const repository =
      dependencies.repository ?? createUserIdentityRepository(getDb());
    const existing = await repository.findByAuthProviderId(clerkUserId);
    let userId = existing?.id;
    if (userId === undefined) {
      const client =
        dependencies.clerkClient ??
        (dependencies.clerkClientFactory ?? runtimeClient)(
          configuration.CLERK_SECRET_KEY,
        );
      const identity = await client.users.getUser(clerkUserId);
      userId = await resolveOrCreateInternalUser(
        identity,
        repository,
        existing,
      );
    }

    cacheUser(clerkUserId, userId);
    c.set("userId", userId);
    c.set("clerkUserId", clerkUserId);
    await next();
  };
}
