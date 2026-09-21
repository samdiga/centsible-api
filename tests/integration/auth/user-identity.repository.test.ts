import { describe, expect, it } from "vitest";

import { createUserIdentityRepository } from "../../../src/platform/auth/user-identity.repository.js";
import {
  createIsolatedTestDatabase,
  readTestDatabaseConfig,
} from "../../support/test-database.js";

function hasExternalTestDatabaseApproval(): boolean {
  try {
    readTestDatabaseConfig(process.env);
    return true;
  } catch {
    return false;
  }
}

const guardedDescribe = hasExternalTestDatabaseApproval()
  ? describe
  : describe.skip;

guardedDescribe("isolated user identity repository", () => {
  it("converges concurrent first requests for one Clerk identity", async () => {
    const testDb = await createIsolatedTestDatabase();
    const peer = await testDb.createPeerClient();
    const repositories = [
      createUserIdentityRepository(testDb.db),
      createUserIdentityRepository(peer.db),
    ];
    let lookups = 0;
    let releaseLookups!: () => void;
    const bothLookedUp = new Promise<void>((resolve) => {
      releaseLookups = resolve;
    });

    for (const repository of repositories) {
      const find = repository.findByAuthProviderId.bind(repository);
      repository.findByAuthProviderId = async (authProviderId) => {
        const result = await find(authProviderId);
        lookups += 1;
        if (lookups === repositories.length) releaseLookups();
        await bothLookedUp;
        return result;
      };
    }

    try {
      const identities = await Promise.all(
        repositories.map((repository) =>
          repository.findOrCreateByAuthProviderId({
            authProviderId: "clerk-concurrent-user",
            email: "concurrent@example.test",
            name: "Concurrent",
          }),
        ),
      );

      expect(new Set(identities.map(({ id }) => id)).size).toBe(1);
    } finally {
      await testDb.cleanup();
    }
  }, 120_000);
});
