import { eq, sql } from "drizzle-orm";
import { userDataVersions } from "../../../database/schema/cache.js";
import { getDb } from "../database/client.js";
import type { Db, DbTransaction } from "../database/types.js";
import { logger, redactLogValue } from "../logging/logger.js";
import type { ResponseCache } from "./response-cache.js";

export const USER_DATA_CHANGED_CHANNEL = "centsible_user_data_changed";

export type UserInvalidationPublisher = (userId: string) => Promise<void>;

export type UserMutationLogger = Readonly<{
  error: (bindings: Record<string, unknown>, message: string) => unknown;
}>;

export type UserMutationDependencies = Readonly<{
  db: Pick<Db, "transaction">;
  cache: Pick<ResponseCache, "invalidateUser">;
  incrementRevision?:
    ((userId: string, tx: DbTransaction) => Promise<bigint>) | undefined;
  publishInvalidation?: UserInvalidationPublisher | undefined;
  onPublishError?: ((error: unknown, userId: string) => void) | undefined;
  logger?: UserMutationLogger | undefined;
}>;

export type UserMutationService = Readonly<{
  withUserMutation: <T>(
    userId: string,
    mutate: (tx: DbTransaction) => Promise<T>,
  ) => Promise<T>;
}>;

export type UserInvalidationSubscription = Readonly<{
  unlisten: () => Promise<void>;
}>;

export type UserInvalidationListener = Readonly<{
  start: () => Promise<void>;
  stop: () => Promise<void>;
}>;

export type UserInvalidationListenerOptions = Readonly<{
  cache: Pick<ResponseCache, "invalidateUser">;
  listen: (
    channel: string,
    onNotification: (payload: string) => void,
  ) => Promise<UserInvalidationSubscription>;
  onInvalidPayload?: ((payload: string) => void) | undefined;
}>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const defaultMutationLogger: UserMutationLogger = {
  error(bindings, message) {
    return logger.error(bindings, message);
  },
};

function reportPublishFailure(
  mutationLogger: UserMutationLogger,
  error: unknown,
  userId: string,
): void {
  mutationLogger.error(
    {
      channel: USER_DATA_CHANGED_CHANNEL,
      error: redactLogValue(error),
      userId,
    },
    "User data invalidation publication failed",
  );
}

/** Reads a user's latest committed revision without creating a row for new users. */
export async function getUserRevision(userId: string, db: Db): Promise<bigint> {
  const rows = await db
    .select({ revision: userDataVersions.revision })
    .from(userDataVersions)
    .where(eq(userDataVersions.userId, userId))
    .limit(1);
  return rows[0]?.revision ?? 0n;
}

/** Atomically creates revision 1 or increments an existing user revision. */
export async function incrementUserRevision(
  userId: string,
  tx: DbTransaction,
): Promise<bigint> {
  const rows = await tx
    .insert(userDataVersions)
    .values({ userId, revision: 1n })
    .onConflictDoUpdate({
      target: userDataVersions.userId,
      set: {
        revision: sql`${userDataVersions.revision} + 1`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ revision: userDataVersions.revision });
  const row = rows[0];
  if (!row) throw new Error("User revision upsert did not return a row");
  return row.revision;
}

/** Publishes only an internal user UUID after a transaction has committed. */
export async function publishUserInvalidation(
  userId: string,
  db: Pick<Db, "execute"> = getDb(),
): Promise<void> {
  await db.execute(
    sql`select pg_notify(${USER_DATA_CHANGED_CHANNEL}, ${userId})`,
  );
}

/**
 * Creates the post-commit write protocol. Dependencies make the transaction,
 * local cache, and cross-process publisher independently testable.
 */
export function createUserMutationService(
  dependencies: UserMutationDependencies,
): UserMutationService {
  const incrementRevision =
    dependencies.incrementRevision ?? incrementUserRevision;
  const publishInvalidation =
    dependencies.publishInvalidation ?? publishUserInvalidation;

  return {
    async withUserMutation<T>(
      userId: string,
      mutate: (tx: DbTransaction) => Promise<T>,
    ): Promise<T> {
      const result = await dependencies.db.transaction(async (tx) => {
        const mutationResult = await mutate(tx);
        await incrementRevision(userId, tx);
        return mutationResult;
      });

      dependencies.cache.invalidateUser(userId);
      try {
        await publishInvalidation(userId);
      } catch (error: unknown) {
        try {
          if (dependencies.onPublishError) {
            dependencies.onPublishError(error, userId);
          } else {
            reportPublishFailure(
              dependencies.logger ?? defaultMutationLogger,
              error,
              userId,
            );
          }
        } catch {
          // An observability hook must not turn a committed mutation into a retry.
        }
      }
      return result;
    },
  };
}

/** Creates a mutation function whose first two arguments are userId and mutate. */
export function createWithUserMutation(
  dependencies: UserMutationDependencies,
): UserMutationService["withUserMutation"] {
  return createUserMutationService(dependencies).withUserMutation;
}

/** Validates a notification payload before it can evict a user's local entries. */
export function isInternalUserId(payload: string): boolean {
  return UUID_PATTERN.test(payload);
}

/**
 * Builds an explicitly-started invalidation listener; importing or creating it
 * never opens a LISTEN connection.
 */
export function createUserInvalidationListener(
  options: UserInvalidationListenerOptions,
): UserInvalidationListener {
  let subscription: UserInvalidationSubscription | undefined;
  let starting: Promise<void> | undefined;

  const start = async (): Promise<void> => {
    if (subscription) return;
    if (starting) return starting;

    starting = options
      .listen(USER_DATA_CHANGED_CHANNEL, (payload) => {
        if (isInternalUserId(payload)) {
          options.cache.invalidateUser(payload);
        } else {
          options.onInvalidPayload?.(payload);
        }
      })
      .then((nextSubscription) => {
        subscription = nextSubscription;
      });
    try {
      await starting;
    } finally {
      starting = undefined;
    }
  };

  const stop = async (): Promise<void> => {
    if (starting) await starting;
    const activeSubscription = subscription;
    subscription = undefined;
    if (activeSubscription) await activeSubscription.unlisten();
  };

  return { start, stop };
}
