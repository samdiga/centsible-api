import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";

import { schema, getDb } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";
import { auditLogRepository } from "../../platform/database/audit-log.repository.js";
import { ValidationError } from "../../platform/errors/app-error.js";
import {
  BACKUP_VERSION,
  type BackupPayload,
  type BackupTransaction,
} from "./user-data.schemas.js";

export type UserDataDb = Db | DbTransaction;
export type UserDataRepository = Readonly<{
  exportMetadata: (
    userId: string,
    db?: UserDataDb,
  ) => Promise<Omit<BackupPayload, "transactions"> & { transactions: [] }>;
  listTransactionPage: (
    userId: string,
    afterId: string | null,
    db?: UserDataDb,
  ) => Promise<BackupTransaction[]>;
  validateBackupReferences: (
    userId: string,
    payload: BackupPayload,
    db?: UserDataDb,
  ) => Promise<void>;
  resetUserData: (userId: string, db?: UserDataDb) => Promise<void>;
  importUserData: (
    userId: string,
    payload: BackupPayload,
    db?: UserDataDb,
  ) => Promise<void>;
  recordAudit?: (
    entry: {
      userId: string;
      entityType: string;
      entityId: string;
      action: "update" | "delete";
      source: string;
    },
    db?: UserDataDb,
  ) => Promise<void>;
}>;

type TransactionRow = Pick<
  typeof schema.transactions.$inferSelect,
  | "id"
  | "accountId"
  | "plaidTransactionId"
  | "amount"
  | "currency"
  | "date"
  | "name"
  | "merchantName"
  | "userName"
  | "categoryId"
  | "notes"
  | "status"
  | "reviewStatus"
  | "excludeFromBudgets"
  | "excludeFromReports"
  | "userCategoryOverride"
>;

function dateValue(value: string | Date): string {
  return typeof value === "string" ? value : value.toISOString().slice(0, 10);
}

function transactionToBackupDto(row: TransactionRow): BackupTransaction {
  return {
    id: row.id,
    accountId: row.accountId,
    plaidTransactionId: row.plaidTransactionId ?? null,
    amount: String(row.amount),
    currency: row.currency ?? null,
    date: dateValue(row.date),
    name: row.name,
    merchantName: row.merchantName ?? null,
    userName: row.userName ?? null,
    categoryId: row.categoryId ?? null,
    notes: row.notes ?? null,
    status: row.status,
    reviewStatus: row.reviewStatus,
    excludeFromBudgets: row.excludeFromBudgets,
    excludeFromReports: row.excludeFromReports,
    userCategoryOverride: row.userCategoryOverride,
  };
}

export { transactionToBackupDto };

function transactionSelect() {
  return {
    id: schema.transactions.id,
    accountId: schema.transactions.accountId,
    plaidTransactionId: schema.transactions.plaidTransactionId,
    amount: schema.transactions.amount,
    currency: schema.transactions.currency,
    date: schema.transactions.date,
    name: schema.transactions.name,
    merchantName: schema.transactions.merchantName,
    userName: schema.transactions.userName,
    categoryId: schema.transactions.categoryId,
    notes: schema.transactions.notes,
    status: schema.transactions.status,
    reviewStatus: schema.transactions.reviewStatus,
    excludeFromBudgets: schema.transactions.excludeFromBudgets,
    excludeFromReports: schema.transactions.excludeFromReports,
    userCategoryOverride: schema.transactions.userCategoryOverride,
  };
}

const PAGE_SIZE = 5_000;
/** 500 rows keeps multi-column inserts safely below PostgreSQL's parameter limit. */
export const IMPORT_BATCH_SIZE = 500;

export function splitImportBatches<T>(
  values: readonly T[],
  batchSize = IMPORT_BATCH_SIZE,
): T[][] {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new ValidationError("Import batch size must be a positive integer.");
  }
  const batches: T[][] = [];
  for (let offset = 0; offset < values.length; offset += batchSize) {
    batches.push([...values.slice(offset, offset + batchSize)]);
  }
  return batches;
}

async function listTransactionPage(
  userId: string,
  afterId: string | null,
  dbh: UserDataDb = getDb(),
): Promise<BackupTransaction[]> {
  const rows = await dbh
    .select(transactionSelect())
    .from(schema.transactions)
    .where(
      and(
        eq(schema.transactions.userId, userId),
        afterId ? gt(schema.transactions.id, afterId) : undefined,
      ),
    )
    .orderBy(asc(schema.transactions.id))
    .limit(PAGE_SIZE);
  return rows.map(transactionToBackupDto);
}

async function exportMetadata(
  userId: string,
  dbh: UserDataDb = getDb(),
): Promise<Omit<BackupPayload, "transactions"> & { transactions: [] }> {
  const db = dbh;
  const [accounts, categories, budgets, recurring, rules] = await Promise.all([
    db.select().from(schema.accounts).where(eq(schema.accounts.userId, userId)),
    db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.userId, userId)),
    db.select().from(schema.budgets).where(eq(schema.budgets.userId, userId)),
    db
      .select()
      .from(schema.billSetup)
      .where(eq(schema.billSetup.userId, userId)),
    db.select().from(schema.rules).where(eq(schema.rules.userId, userId)),
  ]);
  const budgetIds = budgets.map((budget) => budget.id);
  const budgetItems = budgetIds.length
    ? await db
        .select()
        .from(schema.budgetItems)
        .where(inArray(schema.budgetItems.budgetId, budgetIds))
    : [];

  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    accounts: accounts.map((account) => ({
      id: account.id,
      name: account.name,
      officialName: account.officialName,
      mask: account.mask,
      type: account.type,
      subtype: account.subtype,
      currency: account.currency,
      currentBalance:
        account.currentBalance == null ? null : String(account.currentBalance),
      availableBalance:
        account.availableBalance == null
          ? null
          : String(account.availableBalance),
      isHidden: account.isHidden,
    })),
    transactions: [],
    categories: categories.map((category) => ({
      id: category.id,
      parentId: category.parentId,
      name: category.name,
      icon: category.icon,
      color: category.color,
      isIncome: category.isIncome,
      isTransfer: category.isTransfer,
      excludeFromBudgets: category.excludeFromBudgets,
      displayOrder: category.displayOrder,
    })),
    rules: rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      priority: rule.priority,
      matchType: rule.matchType,
      matchMerchant: rule.matchMerchant,
      matchNameContains: rule.matchNameContains,
      matchAmountMin:
        rule.matchAmountMin == null ? null : String(rule.matchAmountMin),
      matchAmountMax:
        rule.matchAmountMax == null ? null : String(rule.matchAmountMax),
      matchAccountId: rule.matchAccountId,
      actionCategoryId: rule.actionCategoryId,
      actionMemberId: rule.actionMemberId,
      actionSetNotes: rule.actionSetNotes,
      actionAddTags: rule.actionAddTags ?? null,
      actionMarkReviewed: rule.actionMarkReviewed ?? null,
      actionExcludeFromBudgets: rule.actionExcludeFromBudgets ?? null,
      isActive: rule.isActive,
    })),
    budgets: budgets.map((budget) => ({
      id: budget.id,
      name: budget.name,
      style: budget.style,
      period: budget.period,
      startDate: budget.startDate,
      isActive: budget.isActive,
      budgetItems: budgetItems
        .filter((item) => item.budgetId === budget.id)
        .map((item) => ({
          categoryId: item.categoryId,
          amountCents: String(item.amount),
          rolloverBehavior: item.rolloverBehavior,
        })),
    })),
    recurring: recurring.map((bill) => ({
      id: bill.id,
      accountId: bill.accountId,
      toAccountId: bill.toAccountId,
      categoryId: bill.categoryId,
      canonicalName: bill.canonicalName,
      billType: bill.billType,
      isIncome: bill.isIncome,
      cadence: bill.cadence,
      dayOfMonth: bill.dayOfMonth,
      dayOfWeek: bill.dayOfWeek,
      avgAmount: String(bill.avgAmount),
      nextExpectedDate: bill.nextExpectedDate,
      status: bill.status,
      userConfirmed: bill.userConfirmed,
      notes: bill.notes,
    })),
  };
}

async function validateBackupReferences(
  userId: string,
  payload: BackupPayload,
  db: UserDataDb = getDb(),
): Promise<void> {
  const accountIds = new Set(payload.accounts.map((account) => account.id));
  const categoryIds = new Set(
    payload.categories.map((category) => category.id),
  );
  const referencedCategoryIds = new Set<string>(categoryIds);
  for (const category of payload.categories) {
    if (category.parentId !== null)
      referencedCategoryIds.add(category.parentId);
  }
  for (const transaction of payload.transactions) {
    if (transaction.categoryId !== null)
      referencedCategoryIds.add(transaction.categoryId);
  }
  for (const rule of payload.rules) {
    if (rule.actionCategoryId !== null)
      referencedCategoryIds.add(rule.actionCategoryId);
  }
  for (const budget of payload.budgets) {
    for (const item of budget.budgetItems)
      referencedCategoryIds.add(item.categoryId);
  }
  for (const bill of payload.recurring) {
    if (bill.categoryId !== null) referencedCategoryIds.add(bill.categoryId);
  }
  const payloadCategoryIds = [...referencedCategoryIds];
  const [systemCategories, members, existingCategories] = await Promise.all([
    db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(isNull(schema.categories.userId)),
    db
      .select({ id: schema.householdMembers.id })
      .from(schema.householdMembers)
      .where(eq(schema.householdMembers.userId, userId)),
    payloadCategoryIds.length
      ? db
          .select({
            id: schema.categories.id,
            userId: schema.categories.userId,
          })
          .from(schema.categories)
          .where(inArray(schema.categories.id, payloadCategoryIds))
      : Promise.resolve([]),
  ]);
  for (const category of existingCategories) {
    if (category.userId !== null && category.userId !== userId) {
      throw new ValidationError(
        "Backup category references a category owned by another user.",
      );
    }
  }
  for (const category of systemCategories) categoryIds.add(category.id);
  const memberIds = new Set(members.map((member) => member.id));
  const assertAccount = (id: string | null, field: string): void => {
    if (id !== null && !accountIds.has(id)) {
      throw new ValidationError(
        `${field} does not reference an account included in this backup.`,
      );
    }
  };
  const assertCategory = (id: string | null, field: string): void => {
    if (id !== null && !categoryIds.has(id)) {
      throw new ValidationError(
        `${field} does not reference a category included in this backup.`,
      );
    }
  };
  for (const category of payload.categories)
    assertCategory(category.parentId, "category.parentId");
  for (const transaction of payload.transactions) {
    assertAccount(transaction.accountId, "transaction.accountId");
    assertCategory(transaction.categoryId, "transaction.categoryId");
  }
  for (const rule of payload.rules) {
    assertAccount(rule.matchAccountId, "rule.matchAccountId");
    assertCategory(rule.actionCategoryId, "rule.actionCategoryId");
    if (rule.actionMemberId !== null && !memberIds.has(rule.actionMemberId)) {
      throw new ValidationError(
        "rule.actionMemberId does not belong to this user.",
      );
    }
  }
  for (const budget of payload.budgets) {
    for (const item of budget.budgetItems)
      assertCategory(item.categoryId, "budgetItem.categoryId");
  }
  for (const bill of payload.recurring) {
    assertAccount(bill.accountId, "recurring.accountId");
    assertAccount(bill.toAccountId, "recurring.toAccountId");
    assertCategory(bill.categoryId, "recurring.categoryId");
  }
}

async function listSystemCategoryIds(db: UserDataDb): Promise<Set<string>> {
  const rows = await db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(isNull(schema.categories.userId));
  return new Set(rows.map((row) => row.id));
}

/** Inserts only user categories; system-ID collisions are intentionally skipped. */
export async function insertUserCategories(
  db: UserDataDb,
  userId: string,
  categories: BackupPayload["categories"],
  systemCategoryIds: ReadonlySet<string>,
): Promise<void> {
  const pending = categories.filter(
    (category) => !systemCategoryIds.has(category.id),
  );
  const inserted = new Set(systemCategoryIds);
  while (pending.length) {
    const ready = pending.filter(
      (category) =>
        category.parentId === null || inserted.has(category.parentId),
    );
    if (!ready.length)
      throw new ValidationError(
        "Backup categories contain a circular parent reference.",
      );
    for (const batch of splitImportBatches(ready)) {
      // Do not use onConflictDoNothing here. A concurrent tenant collision
      // must abort the whole transaction instead of silently losing data.
      await db.insert(schema.categories).values(
        batch.map((category) => ({
          id: category.id,
          userId,
          parentId: category.parentId,
          name: category.name,
          icon: category.icon,
          color: category.color,
          isIncome: category.isIncome,
          isTransfer: category.isTransfer,
          excludeFromBudgets: category.excludeFromBudgets,
          displayOrder: category.displayOrder,
        })),
      );
    }
    for (const category of ready) inserted.add(category.id);
    for (const category of ready) pending.splice(pending.indexOf(category), 1);
  }
}

async function resetUserData(userId: string, dbh?: UserDataDb): Promise<void> {
  if (!dbh) return getDb().transaction((tx) => resetUserData(userId, tx));
  const db = dbh;
  // Delete dependants explicitly so this remains correct if a database FK is
  // tightened from cascade to restrict in a later migration.
  await db.delete(schema.auditLog).where(eq(schema.auditLog.userId, userId));
  await db
    .delete(schema.notifications)
    .where(eq(schema.notifications.userId, userId));
  await db
    .delete(schema.notificationPreferences)
    .where(eq(schema.notificationPreferences.userId, userId));
  await db
    .delete(schema.aiMessages)
    .where(eq(schema.aiMessages.userId, userId));
  await db
    .delete(schema.aiSessions)
    .where(eq(schema.aiSessions.userId, userId));
  await db
    .delete(schema.forecastEvents)
    .where(eq(schema.forecastEvents.userId, userId));
  await db
    .delete(schema.forecastScenarios)
    .where(eq(schema.forecastScenarios.userId, userId));
  await db
    .delete(schema.forecastRuns)
    .where(eq(schema.forecastRuns.userId, userId));
  await db
    .delete(schema.netWorthSnapshots)
    .where(eq(schema.netWorthSnapshots.userId, userId));
  await db
    .delete(schema.goalContributions)
    .where(eq(schema.goalContributions.userId, userId));
  await db.delete(schema.goals).where(eq(schema.goals.userId, userId));
  await db
    .delete(schema.billOccurrences)
    .where(eq(schema.billOccurrences.userId, userId));
  await db.delete(schema.billSetup).where(eq(schema.billSetup.userId, userId));
  await db.delete(schema.rules).where(eq(schema.rules.userId, userId));
  await db
    .delete(schema.transactions)
    .where(eq(schema.transactions.userId, userId));
  await db.delete(schema.tags).where(eq(schema.tags.userId, userId));
  await db.delete(schema.budgets).where(eq(schema.budgets.userId, userId));
  await db
    .delete(schema.manualAssets)
    .where(eq(schema.manualAssets.userId, userId));
  await db.delete(schema.holdings).where(eq(schema.holdings.userId, userId));
  await db
    .delete(schema.transactionEmbeddings)
    .where(eq(schema.transactionEmbeddings.userId, userId));
  await db
    .delete(schema.plaidRawImports)
    .where(eq(schema.plaidRawImports.userId, userId));
  await db.delete(schema.accounts).where(eq(schema.accounts.userId, userId));
  await db
    .delete(schema.plaidItems)
    .where(eq(schema.plaidItems.userId, userId));
  await db
    .delete(schema.featureFlags)
    .where(eq(schema.featureFlags.userId, userId));
  await db.delete(schema.jobs).where(eq(schema.jobs.userId, userId));
  await db
    .delete(schema.pipelineRuns)
    .where(eq(schema.pipelineRuns.userId, userId));
  await db
    .delete(schema.syncSchedules)
    .where(eq(schema.syncSchedules.userId, userId));
  await db
    .delete(schema.categories)
    .where(eq(schema.categories.userId, userId));
}

async function importUserData(
  userId: string,
  payload: BackupPayload,
  dbh?: UserDataDb,
): Promise<void> {
  if (!dbh)
    return getDb().transaction((tx) => importUserData(userId, payload, tx));
  const db = dbh;
  await resetUserData(userId, db);
  if (payload.accounts.length) {
    for (const batch of splitImportBatches(payload.accounts)) {
      await db.insert(schema.accounts).values(
        batch.map((account) => ({
          id: account.id,
          userId,
          plaidItemId: null,
          plaidAccountId: null,
          name: account.name,
          officialName: account.officialName,
          type: account.type as typeof schema.accounts.$inferInsert.type,
          subtype:
            account.subtype as typeof schema.accounts.$inferInsert.subtype,
          mask: account.mask,
          currency: account.currency ?? "USD",
          currentBalance:
            account.currentBalance == null
              ? null
              : BigInt(account.currentBalance),
          availableBalance:
            account.availableBalance == null
              ? null
              : BigInt(account.availableBalance),
          isHidden: account.isHidden,
        })),
      );
    }
  }
  if (payload.categories.length) {
    // System categories survive reset and may be parents of imported custom
    // categories, so they are valid roots for the insertion topological sort.
    await insertUserCategories(
      db,
      userId,
      payload.categories,
      await listSystemCategoryIds(db),
    );
  }
  if (payload.transactions.length) {
    for (const batch of splitImportBatches(payload.transactions)) {
      await db.insert(schema.transactions).values(
        batch.map((transaction) => ({
          id: transaction.id,
          userId,
          accountId: transaction.accountId,
          plaidTransactionId: null,
          amount: BigInt(transaction.amount),
          currency: transaction.currency ?? "USD",
          date: transaction.date,
          name: transaction.name,
          merchantName: transaction.merchantName,
          userName: transaction.userName,
          categoryId: transaction.categoryId,
          notes: transaction.notes,
          status: transaction.status,
          reviewStatus: transaction.reviewStatus,
          excludeFromBudgets: transaction.excludeFromBudgets,
          excludeFromReports: transaction.excludeFromReports,
          userCategoryOverride: transaction.userCategoryOverride,
        })),
      );
    }
  }
  if (payload.rules.length) {
    for (const batch of splitImportBatches(payload.rules)) {
      await db.insert(schema.rules).values(
        batch.map((rule) => ({
          id: rule.id,
          userId,
          name: rule.name,
          priority: rule.priority,
          matchType: rule.matchType,
          matchMerchant: rule.matchMerchant,
          matchNameContains: rule.matchNameContains,
          matchAmountMin:
            rule.matchAmountMin == null ? null : BigInt(rule.matchAmountMin),
          matchAmountMax:
            rule.matchAmountMax == null ? null : BigInt(rule.matchAmountMax),
          matchAccountId: rule.matchAccountId,
          actionCategoryId: rule.actionCategoryId,
          actionMemberId: rule.actionMemberId,
          actionSetNotes: rule.actionSetNotes,
          actionAddTags: rule.actionAddTags,
          actionMarkReviewed: rule.actionMarkReviewed,
          actionExcludeFromBudgets: rule.actionExcludeFromBudgets,
          isActive: rule.isActive,
        })),
      );
    }
  }
  for (const budget of payload.budgets) {
    await db.insert(schema.budgets).values({
      id: budget.id,
      userId,
      name: budget.name,
      style: budget.style,
      period: budget.period,
      startDate: budget.startDate,
      isActive: budget.isActive,
    });
    if (budget.budgetItems.length) {
      for (const batch of splitImportBatches(budget.budgetItems)) {
        await db.insert(schema.budgetItems).values(
          batch.map((item) => ({
            budgetId: budget.id,
            categoryId: item.categoryId,
            amount: BigInt(item.amountCents),
            rolloverBehavior: item.rolloverBehavior,
          })),
        );
      }
    }
  }
  if (payload.recurring.length) {
    for (const batch of splitImportBatches(payload.recurring)) {
      await db.insert(schema.billSetup).values(
        batch.map((bill) => ({
          id: bill.id,
          userId,
          accountId: bill.accountId,
          toAccountId: bill.toAccountId,
          categoryId: bill.categoryId,
          canonicalName: bill.canonicalName,
          billType: bill.billType,
          isIncome: bill.isIncome,
          cadence: bill.cadence,
          dayOfMonth: bill.dayOfMonth,
          dayOfWeek: bill.dayOfWeek,
          avgAmount: BigInt(bill.avgAmount),
          nextExpectedDate: bill.nextExpectedDate,
          status: bill.status,
          userConfirmed: bill.userConfirmed,
          notes: bill.notes,
        })),
      );
    }
  }
}

export const userDataRepository: UserDataRepository = {
  exportMetadata,
  listTransactionPage,
  validateBackupReferences,
  resetUserData,
  importUserData,
  recordAudit: async (entry, db) =>
    auditLogRepository.record(
      { ...entry, before: undefined, after: undefined },
      db,
    ),
};

export function createUserDataRepository(db: Db): UserDataRepository {
  return {
    exportMetadata: (userId) => exportMetadata(userId, db),
    listTransactionPage: (userId, afterId) =>
      listTransactionPage(userId, afterId, db),
    validateBackupReferences: (userId, payload) =>
      validateBackupReferences(userId, payload, db),
    resetUserData: (userId, transaction) =>
      transaction
        ? resetUserData(userId, transaction)
        : db.transaction((tx) => resetUserData(userId, tx)),
    importUserData: (userId, payload, transaction) =>
      transaction
        ? importUserData(userId, payload, transaction)
        : db.transaction((tx) => importUserData(userId, payload, tx)),
    recordAudit: (entry, transaction) =>
      auditLogRepository.record(
        { ...entry, before: undefined, after: undefined },
        transaction ?? db,
      ),
  };
}

export const userDataRepo = userDataRepository;
