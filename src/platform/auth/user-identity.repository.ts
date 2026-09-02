import { eq } from "drizzle-orm";
import { users } from "../../../database/schema/schema.js";
import type { Db } from "../database/types.js";

export type UserIdentity = {
  id: string;
  emailAddresses: ReadonlyArray<{ emailAddress: string }>;
  firstName: string | null | undefined;
};

export type InternalUser = { id: string };

export type UserIdentityRepository = {
  findByAuthProviderId: (
    authProviderId: string,
  ) => Promise<InternalUser | null>;
  findOrCreateByAuthProviderId: (input: {
    authProviderId: string;
    email: string;
    name: string | undefined;
  }) => Promise<InternalUser>;
};

/** Creates the database boundary used by Clerk identity resolution. */
export function createUserIdentityRepository(db: Db): UserIdentityRepository {
  return {
    async findByAuthProviderId(authProviderId) {
      const rows = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.authProviderId, authProviderId))
        .limit(1);
      return rows[0] ?? null;
    },
    async findOrCreateByAuthProviderId(input) {
      const existing = await this.findByAuthProviderId(input.authProviderId);
      if (existing) return existing;

      const rows = await db
        .insert(users)
        .values({
          authProviderId: input.authProviderId,
          email: input.email,
          name: input.name ?? null,
        })
        .onConflictDoUpdate({
          target: users.authProviderId,
          set: {
            email: input.email,
            name: input.name ?? null,
            updatedAt: new Date(),
          },
        })
        .returning({ id: users.id });
      const created = rows[0];
      if (!created) throw new Error("User identity upsert returned no row");
      return created;
    },
  };
}

/** Finds an existing provider mapping or safely creates one from Clerk identity data. */
export async function resolveOrCreateInternalUser(
  clerkIdentity: UserIdentity,
  db: UserIdentityRepository,
  existing: InternalUser | null | undefined = undefined,
): Promise<string> {
  const mapped =
    existing === undefined
      ? await db.findByAuthProviderId(clerkIdentity.id)
      : existing;
  if (mapped) return mapped.id;

  const email =
    clerkIdentity.emailAddresses[0]?.emailAddress ??
    `${clerkIdentity.id}@clerk.local`;
  const user = await db.findOrCreateByAuthProviderId({
    authProviderId: clerkIdentity.id,
    email,
    name: clerkIdentity.firstName ?? undefined,
  });
  return user.id;
}
