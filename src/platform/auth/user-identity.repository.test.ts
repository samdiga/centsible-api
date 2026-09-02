import { describe, expect, it, vi } from "vitest";
import {
  resolveOrCreateInternalUser,
  type UserIdentityRepository,
} from "./user-identity.repository.js";

function repository(existingId?: string): UserIdentityRepository {
  return {
    findByAuthProviderId: vi.fn(async () =>
      existingId ? { id: existingId } : null,
    ),
    findOrCreateByAuthProviderId: vi.fn(async () => ({ id: "created-user" })),
  };
}

describe("resolveOrCreateInternalUser", () => {
  it("returns an existing mapping without hydrating or upserting it", async () => {
    const db = repository("existing-user");
    const id = await resolveOrCreateInternalUser(
      {
        id: "clerk_1",
        emailAddresses: [{ emailAddress: "new@example.test" }],
        firstName: "New",
      },
      db,
    );

    expect(id).toBe("existing-user");
    expect(db.findOrCreateByAuthProviderId).not.toHaveBeenCalled();
  });

  it("upserts a missing identity using first Clerk email and first name", async () => {
    const db = repository();
    const id = await resolveOrCreateInternalUser(
      {
        id: "clerk_2",
        emailAddresses: [
          { emailAddress: "first@example.test" },
          { emailAddress: "second@example.test" },
        ],
        firstName: "First",
      },
      db,
    );

    expect(id).toBe("created-user");
    expect(db.findOrCreateByAuthProviderId).toHaveBeenCalledWith({
      authProviderId: "clerk_2",
      email: "first@example.test",
      name: "First",
    });
  });

  it("uses a deterministic local email fallback", async () => {
    const db = repository();
    await resolveOrCreateInternalUser(
      { id: "clerk_3", emailAddresses: [], firstName: null },
      db,
    );

    expect(db.findOrCreateByAuthProviderId).toHaveBeenCalledWith({
      authProviderId: "clerk_3",
      email: "clerk_3@clerk.local",
      name: undefined,
    });
  });
});
