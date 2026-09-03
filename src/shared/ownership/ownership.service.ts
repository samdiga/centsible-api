import { ValidationError } from "../../platform/errors/app-error.js";

export type CategoryOwnershipRepository = {
  getCategoryById(userId: string, categoryId: string): Promise<unknown | null>;
};

export type AccountOwnershipRepository = {
  findById(accountId: string, userId: string): Promise<unknown | null>;
};

export type HouseholdMemberOwnershipRepository = {
  findById(memberId: string, userId: string): Promise<unknown | null>;
};

export async function requireOwnedCategory(
  repository: CategoryOwnershipRepository,
  userId: string,
  categoryId: string | null | undefined,
): Promise<void> {
  if (categoryId == null) return;
  if (!(await repository.getCategoryById(userId, categoryId))) {
    throw new ValidationError(
      "categoryId does not exist or is not accessible to this user.",
    );
  }
}

export async function requireOwnedAccount(
  repository: AccountOwnershipRepository,
  userId: string,
  accountId: string | null | undefined,
): Promise<void> {
  if (accountId == null) return;
  if (!(await repository.findById(accountId, userId))) {
    throw new ValidationError(
      "accountId does not exist or is not accessible to this user.",
    );
  }
}

export async function requireOwnedHouseholdMember(
  repository: HouseholdMemberOwnershipRepository,
  userId: string,
  memberId: string | null | undefined,
): Promise<void> {
  if (memberId == null) return;
  if (!(await repository.findById(memberId, userId))) {
    throw new ValidationError(
      "householdMemberId does not exist or is not accessible to this user.",
    );
  }
}
