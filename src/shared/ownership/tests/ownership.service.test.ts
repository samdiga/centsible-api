import { describe, expect, it, vi } from "vitest";

import { ValidationError } from "../../../platform/errors/app-error.js";
import {
  requireOwnedAccount,
  requireOwnedCategory,
  requireOwnedHouseholdMember,
} from "../ownership.service.js";

describe("ownership requirements", () => {
  it("rejects inaccessible category, account, and household-member references", async () => {
    const categories = { getCategoryById: vi.fn(async () => null) };
    const accounts = { findById: vi.fn(async () => null) };
    const householdMembers = { findById: vi.fn(async () => null) };

    await expect(
      requireOwnedCategory(categories, "user-1", "category-1"),
    ).rejects.toThrow(ValidationError);
    await expect(
      requireOwnedAccount(accounts, "user-1", "account-1"),
    ).rejects.toThrow(ValidationError);
    await expect(
      requireOwnedHouseholdMember(householdMembers, "user-1", "member-1"),
    ).rejects.toThrow(ValidationError);
  });

  it("leaves optional ownership references unset", async () => {
    const categories = { getCategoryById: vi.fn(async () => null) };
    const accounts = { findById: vi.fn(async () => null) };
    const householdMembers = { findById: vi.fn(async () => null) };

    await expect(
      requireOwnedCategory(categories, "user-1", null),
    ).resolves.toBeUndefined();
    await expect(
      requireOwnedAccount(accounts, "user-1", undefined),
    ).resolves.toBeUndefined();
    await expect(
      requireOwnedHouseholdMember(householdMembers, "user-1", null),
    ).resolves.toBeUndefined();
    expect(categories.getCategoryById).not.toHaveBeenCalled();
    expect(accounts.findById).not.toHaveBeenCalled();
    expect(householdMembers.findById).not.toHaveBeenCalled();
  });
});
