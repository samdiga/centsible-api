import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";
import {
  ConflictError,
  NotFoundError,
} from "../../platform/errors/app-error.js";
import type { PlaidAccountData } from "./accounts.schemas.js";
export type { PlaidAccountData } from "./accounts.schemas.js";

export type AccountRow = typeof schema.accounts.$inferSelect;
export type AccountType = (typeof schema.accountTypeEnum.enumValues)[number];
export type AccountSubtype =
  (typeof schema.accountSubtypeEnum.enumValues)[number];
export type AccountDb = Db | DbTransaction;
export type PlaidItemRow = typeof schema.plaidItems.$inferSelect;

const accountTypes: readonly AccountType[] = [
  "depository",
  "credit",
  "loan",
  "investment",
  "other",
];
const accountSubtypes: readonly AccountSubtype[] = [
  "checking",
  "savings",
  "money_market",
  "cd",
  "hsa",
  "credit_card",
  "line_of_credit",
  "paypal",
  "mortgage",
  "auto",
  "student",
  "personal_loan",
  "brokerage",
  "ira",
  "401k",
  "403b",
  "529",
  "roth",
  "roth_401k",
  "manual_home",
  "manual_vehicle",
  "crypto",
  "cash",
  "other",
];

export function mapAccountType(type: string | null | undefined): AccountType {
  const value = (type ?? "").toLowerCase() as AccountType;
  return accountTypes.includes(value) ? value : "other";
}

export function mapAccountSubtype(
  subtype: string | null | undefined,
): AccountSubtype {
  const value = (subtype ?? "")
    .toLowerCase()
    .replace(/-/g, "_") as AccountSubtype;
  return accountSubtypes.includes(value) ? value : "other";
}

export function dollarsToCents(
  amount: number | null | undefined,
): bigint | null {
  if (amount == null) return null;
  if (!Number.isFinite(amount))
    throw new ConflictError("Plaid returned an invalid balance");
  return BigInt(Math.round(amount * 100));
}

export interface LiabilityData {
  apr?: number | null;
  apy?: number | null;
  minimumPayment?: bigint | null;
  paymentDueDate?: string | null;
  statementBalance?: bigint | null;
  statementDate?: string | null;
  originationDate?: string | null;
  maturityDate?: string | null;
}

export type AccountWithItem = AccountRow & {
  plaidItem: {
    id: string;
    status: (typeof schema.plaidItemStatusEnum.enumValues)[number];
    errorCode: string | null;
    institutionId: string | null;
    institutionName: string | null;
  };
};

export type AccountAudit = Readonly<{
  userId: string;
  entityId: string;
  action: "delete" | "sync";
  source: string;
  before?: unknown;
  after?: unknown;
}>;

export type AccountRepository = Readonly<{
  listByUser: (userId: string, db?: AccountDb) => Promise<AccountWithItem[]>;
  findById: (
    userId: string,
    accountId: string,
    db?: AccountDb,
  ) => Promise<AccountRow | null>;
  findByIdForUpdate: (
    userId: string,
    accountId: string,
    db: DbTransaction,
  ) => Promise<AccountRow | null>;
  findOwnedItem: (
    userId: string,
    itemId: string,
    db?: AccountDb,
  ) => Promise<PlaidItemRow | null>;
  findByPlaidAccountId: (
    plaidAccountId: string,
    userId: string,
    db?: AccountDb,
  ) => Promise<AccountRow | null>;
  findByPlaidAccountIds: (
    plaidAccountIds: string[],
    userId: string,
    db?: AccountDb,
  ) => Promise<AccountRow[]>;
  findByItem: (
    plaidItemUuid: string,
    userId: string,
    db?: AccountDb,
  ) => Promise<AccountRow[]>;
  upsertFromPlaid: (
    args: { userId: string; plaidItemUuid: string; account: PlaidAccountData },
    db?: AccountDb,
  ) => Promise<AccountRow>;
  updateBalances: (
    plaidAccountId: string,
    userId: string,
    balances: {
      current?: number | null;
      available?: number | null;
      limit?: number | null;
    },
    db?: AccountDb,
  ) => Promise<AccountRow | null>;
  updateLiabilities: (
    userId: string,
    plaidAccountId: string,
    data: LiabilityData,
    db?: AccountDb,
  ) => Promise<boolean>;
  lockItem: (userId: string, itemId: string, db: AccountDb) => Promise<void>;
  softDelete: (
    userId: string,
    accountId: string,
    db?: AccountDb,
  ) => Promise<AccountRow | null>;
  countLiveByItem: (
    userId: string,
    itemId: string,
    db?: AccountDb,
  ) => Promise<number>;
  recordAudit: (audit: AccountAudit, db?: AccountDb) => Promise<void>;
}>;

function ownedItem(userId: string, itemId: string, db: AccountDb) {
  return db
    .select()
    .from(schema.plaidItems)
    .where(
      and(
        eq(schema.plaidItems.id, itemId),
        eq(schema.plaidItems.userId, userId),
      ),
    )
    .limit(1);
}

async function findOwnedItem(
  userId: string,
  itemId: string,
  db: AccountDb,
): Promise<PlaidItemRow | null> {
  return (await ownedItem(userId, itemId, db))[0] ?? null;
}

async function performUpsertFromPlaid(
  args: { userId: string; plaidItemUuid: string; account: PlaidAccountData },
  db: AccountDb,
): Promise<AccountRow> {
  // Serialize all writers for the global Plaid account identity before any
  // membership lock. This prevents an insert/conflict reconciliation from
  // holding the new-item lock while a relink holds the old-item lock.
  await lockAdvisoryKey(db, `plaid-account:${args.account.account_id}`);
  const item = (await ownedItem(args.userId, args.plaidItemUuid, db))[0];
  if (!item) throw new NotFoundError("Plaid item");
  const { account } = args;
  const currentBalance = dollarsToCents(account.balances.current);
  const availableBalance = dollarsToCents(account.balances.available);
  const limit = dollarsToCents(account.balances.limit);
  const payload = {
    name: account.name,
    officialName: account.official_name ?? null,
    type: mapAccountType(account.type),
    subtype: mapAccountSubtype(account.subtype),
    mask: account.mask ?? null,
    currency: account.balances.iso_currency_code ?? "USD",
    currentBalance,
    availableBalance,
    limit,
    balanceLastRefreshedAt: new Date(),
    updatedAt: new Date(),
  };
  const existing = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.plaidAccountId, account.account_id))
    .limit(1)
    .for("update");
  if (existing[0] && existing[0].userId !== args.userId)
    throw new ConflictError("Plaid account belongs to another user");
  if (existing[0]) {
    await lockItems(
      args.userId,
      [existing[0].plaidItemId, args.plaidItemUuid],
      db,
    );
    const rows = await db
      .update(schema.accounts)
      .set({
        ...payload,
        plaidItemId: args.plaidItemUuid,
        // Evaluate against the row currently locked by this transaction. A
        // stale JavaScript snapshot must never resurrect a committed delete.
        deletedAt: sql`case when ${schema.accounts.plaidItemId} = ${args.plaidItemUuid} then ${schema.accounts.deletedAt} else null end`,
      })
      .where(
        and(
          eq(schema.accounts.id, existing[0].id),
          eq(schema.accounts.userId, args.userId),
        ),
      )
      .returning();
    const row = rows[0];
    if (!row) throw new ConflictError("Account could not be updated");
    return row;
  }
  await lockItems(args.userId, [args.plaidItemUuid], db);
  let rows: AccountRow[];
  try {
    rows = await db
      .insert(schema.accounts)
      .values({
        userId: args.userId,
        plaidItemId: args.plaidItemUuid,
        plaidAccountId: account.account_id,
        ...payload,
      })
      .onConflictDoNothing({ target: schema.accounts.plaidAccountId })
      .returning();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    rows = [];
  }
  const row = rows[0];
  if (row) return row;

  // A concurrent writer won the global plaidAccountId race. Reconcile the
  // committed row without ever exposing or mutating another tenant's account.
  const conflicted = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.plaidAccountId, account.account_id))
    .limit(1)
    .for("update");
  const conflict = conflicted[0];
  if (!conflict)
    throw new ConflictError("Account insert conflict could not be resolved");
  if (conflict.userId !== args.userId)
    throw new ConflictError("Plaid account belongs to another user");
  await lockItems(args.userId, [conflict.plaidItemId, args.plaidItemUuid], db);
  const reconciled = await db
    .update(schema.accounts)
    .set({
      ...payload,
      plaidItemId: args.plaidItemUuid,
      deletedAt: sql`case when ${schema.accounts.plaidItemId} = ${args.plaidItemUuid} then ${schema.accounts.deletedAt} else null end`,
    })
    .where(
      and(
        eq(schema.accounts.id, conflict.id),
        eq(schema.accounts.userId, args.userId),
      ),
    )
    .returning();
  const reconciledRow = reconciled[0];
  if (!reconciledRow)
    throw new ConflictError("Account conflict could not be reconciled");
  return reconciledRow;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

async function lockItems(
  userId: string,
  itemIds: readonly (string | null)[],
  db: AccountDb,
): Promise<void> {
  const sorted = [
    ...new Set(itemIds.filter((itemId): itemId is string => itemId !== null)),
  ].sort();
  for (const itemId of sorted) {
    await lockAdvisoryKey(db, `${userId}:${itemId}`);
  }
}

async function lockAdvisoryKey(db: AccountDb, key: string): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

export const accountRepository: AccountRepository = {
  async listByUser(userId, db = getDb()) {
    const rows = await db
      .select({
        account: schema.accounts,
        item: {
          id: schema.plaidItems.id,
          status: schema.plaidItems.status,
          errorCode: schema.plaidItems.errorCode,
          institutionId: schema.plaidItems.institutionId,
          institutionName: schema.plaidItems.institutionName,
        },
      })
      .from(schema.accounts)
      .innerJoin(
        schema.plaidItems,
        and(
          eq(schema.accounts.plaidItemId, schema.plaidItems.id),
          eq(schema.plaidItems.userId, userId),
        ),
      )
      .where(
        and(
          eq(schema.accounts.userId, userId),
          isNull(schema.accounts.deletedAt),
        ),
      )
      .orderBy(asc(schema.accounts.createdAt), asc(schema.accounts.id));
    return rows.map((row) => ({ ...row.account, plaidItem: row.item }));
  },
  async findById(userId, accountId, db = getDb()) {
    const rows = await db
      .select()
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.id, accountId),
          eq(schema.accounts.userId, userId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async findByIdForUpdate(userId, accountId, db) {
    const rows = await db
      .select()
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.id, accountId),
          eq(schema.accounts.userId, userId),
        ),
      )
      .limit(1)
      .for("update");
    return rows[0] ?? null;
  },
  async findOwnedItem(userId, itemId, db = getDb()) {
    return findOwnedItem(userId, itemId, db);
  },
  async findByPlaidAccountId(plaidAccountId, userId, db = getDb()) {
    const rows = await db
      .select()
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.plaidAccountId, plaidAccountId),
          eq(schema.accounts.userId, userId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
  async findByPlaidAccountIds(plaidAccountIds, userId, db = getDb()) {
    if (plaidAccountIds.length === 0) return [];
    return db
      .select()
      .from(schema.accounts)
      .where(
        and(
          inArray(schema.accounts.plaidAccountId, plaidAccountIds),
          eq(schema.accounts.userId, userId),
        ),
      );
  },
  async findByItem(itemId, userId, db = getDb()) {
    return db
      .select()
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.plaidItemId, itemId),
          eq(schema.accounts.userId, userId),
        ),
      );
  },
  async upsertFromPlaid(args, db = getDb()) {
    return performUpsertFromPlaid(args, db);
  },
  async updateBalances(plaidAccountId, userId, balances, db = getDb()) {
    const rows = await db
      .update(schema.accounts)
      .set({
        currentBalance: dollarsToCents(balances.current),
        availableBalance: dollarsToCents(balances.available),
        limit: dollarsToCents(balances.limit),
        balanceLastRefreshedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.accounts.plaidAccountId, plaidAccountId),
          eq(schema.accounts.userId, userId),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },
  async updateLiabilities(userId, plaidAccountId, data, db = getDb()) {
    const values: Partial<typeof schema.accounts.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (data.apr !== undefined) values.apr = data.apr;
    if (data.apy !== undefined) values.apy = data.apy;
    if (data.minimumPayment !== undefined)
      values.minimumPayment = data.minimumPayment;
    if (data.paymentDueDate !== undefined)
      values.paymentDueDate = data.paymentDueDate;
    if (data.statementBalance !== undefined)
      values.statementBalance = data.statementBalance;
    if (data.statementDate !== undefined)
      values.statementDate = data.statementDate;
    if (data.originationDate !== undefined)
      values.originationDate = data.originationDate;
    if (data.maturityDate !== undefined)
      values.maturityDate = data.maturityDate;
    const rows = await db
      .update(schema.accounts)
      .set(values)
      .where(
        and(
          eq(schema.accounts.plaidAccountId, plaidAccountId),
          eq(schema.accounts.userId, userId),
        ),
      )
      .returning({ id: schema.accounts.id });
    return rows.length > 0;
  },
  async lockItem(userId, itemId, db) {
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${userId}:${itemId}`}, 0))`,
    );
  },
  async softDelete(userId, accountId, db = getDb()) {
    const now = new Date();
    const rows = await db
      .update(schema.accounts)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.accounts.id, accountId),
          eq(schema.accounts.userId, userId),
          isNull(schema.accounts.deletedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },
  async countLiveByItem(userId, itemId, db = getDb()) {
    const rows = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.plaidItemId, itemId),
          eq(schema.accounts.userId, userId),
          isNull(schema.accounts.deletedAt),
        ),
      );
    return rows.length;
  },
  async recordAudit(audit, db = getDb()) {
    await db.insert(schema.auditLog).values({
      userId: audit.userId,
      entityType: "account",
      entityId: audit.entityId,
      action: audit.action,
      source: audit.source,
      ...(audit.before === undefined ? {} : { beforeJson: audit.before }),
      ...(audit.after === undefined ? {} : { afterJson: audit.after }),
    });
  },
};

/** Compatibility entry point for Plaid sync callers; new code should inject PlaidAccountWriter. */
export async function upsertFromPlaid(
  args: {
    userId: string;
    plaidItemUuid: string;
    account: PlaidAccountData;
  },
  db: AccountDb = getDb(),
): Promise<AccountRow> {
  return performUpsertFromPlaid(args, db);
}

export function createAccountRepository(db: Db): AccountRepository {
  return {
    listByUser: (userId, transaction) =>
      accountRepository.listByUser(userId, transaction ?? db),
    findById: (userId, id, transaction) =>
      accountRepository.findById(userId, id, transaction ?? db),
    findByIdForUpdate: (userId, id, transaction) => {
      if (!transaction)
        throw new Error("findByIdForUpdate requires an active transaction");
      return accountRepository.findByIdForUpdate(userId, id, transaction);
    },
    findOwnedItem: (userId, itemId, transaction) =>
      accountRepository.findOwnedItem(userId, itemId, transaction ?? db),
    findByPlaidAccountId: (id, userId, transaction) =>
      accountRepository.findByPlaidAccountId(id, userId, transaction ?? db),
    findByPlaidAccountIds: (ids, userId, transaction) =>
      accountRepository.findByPlaidAccountIds(ids, userId, transaction ?? db),
    findByItem: (id, userId, transaction) =>
      accountRepository.findByItem(id, userId, transaction ?? db),
    upsertFromPlaid: (args, transaction) =>
      transaction
        ? performUpsertFromPlaid(args, transaction)
        : db.transaction((activeTransaction) =>
            performUpsertFromPlaid(args, activeTransaction),
          ),
    updateBalances: (id, userId, balances, transaction) =>
      accountRepository.updateBalances(id, userId, balances, transaction ?? db),
    updateLiabilities: (userId, id, data, transaction) =>
      accountRepository.updateLiabilities(userId, id, data, transaction ?? db),
    lockItem: (userId, itemId, transaction) =>
      accountRepository.lockItem(userId, itemId, transaction ?? db),
    softDelete: (userId, id, transaction) =>
      accountRepository.softDelete(userId, id, transaction ?? db),
    countLiveByItem: (userId, itemId, transaction) =>
      accountRepository.countLiveByItem(userId, itemId, transaction ?? db),
    recordAudit: (audit, transaction) =>
      accountRepository.recordAudit(audit, transaction ?? db),
  };
}

export type PlaidAccountRecord = Readonly<{
  id: string;
  userId: string;
  plaidItemId: string | null;
  plaidAccountId: string | null;
}>;

export type PlaidAccountWriter = Readonly<{
  upsertFromPlaid: (
    input: {
      userId: string;
      plaidItemUuid: string;
      account: PlaidAccountData;
    },
    transaction?: DbTransaction,
  ) => Promise<PlaidAccountRecord>;
}>;

/** Creates the narrow Plaid sync port without exposing the repository. */
export function createPlaidAccountWriter(db: Db): PlaidAccountWriter {
  return {
    async upsertFromPlaid(input, transaction) {
      if (transaction) return performUpsertFromPlaid(input, transaction);
      return db.transaction((activeTransaction) =>
        performUpsertFromPlaid(input, activeTransaction),
      );
    },
  };
}
