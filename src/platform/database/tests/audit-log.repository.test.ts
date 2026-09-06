import { describe, expect, it, vi } from "vitest";

import { createAuditLogRepository } from "../audit-log.repository.js";
import { ValidationError } from "../../errors/app-error.js";

describe("audit log repository", () => {
  it("writes audit data through the supplied database client", async () => {
    const values = vi.fn(async () => undefined);
    const insert = vi.fn(() => ({ values }));
    const repository = createAuditLogRepository({ insert } as never);
    await repository.record({
      userId: "11111111-1111-4111-8111-111111111111",
      entityType: "user_data",
      entityId: "11111111-1111-4111-8111-111111111111",
      action: "delete",
      source: "user.reset",
      after: { ok: true },
    });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "user_data",
        action: "delete",
        source: "user.reset",
      }),
    );
  });

  it("validates retention days before issuing a purge", async () => {
    const repository = createAuditLogRepository({ delete: vi.fn() } as never);
    await expect(repository.purgeOlderThanDays(0)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
