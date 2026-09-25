import { getDb } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";
import { auditLogRepository } from "../../platform/database/audit-log.repository.js";
import type { AuditLogRepository } from "../../platform/database/audit-log.repository.js";
import {
  createResponseCache,
  type ResponseCache,
} from "../../platform/cache/response-cache.js";
import {
  createWithUserMutation,
  type UserMutationService,
} from "../../platform/cache/user-revisions.repository.js";
import { consumeToken } from "../../platform/http/rate-limit.js";
import { logger as runtimeLogger } from "../../platform/logging/logger.js";
import { redactLogValue } from "../../platform/logging/redaction.js";
import { NotFoundError } from "../../platform/errors/app-error.js";
import {
  createPlaidAccountWriter,
  createPlaidBalanceWriter,
  type PlaidAccountWriter,
  type PlaidBalanceWriter,
} from "../accounts/index.js";
import type { AccountBalance } from "../accounts/accounts.schemas.js";
import { startPipelineRun } from "../pipeline/pipeline.service.js";
import { createPlaidClient, type PlaidClientPort } from "./plaid.client.js";
import {
  decryptToken,
  encryptToken,
  type TokenCipher,
} from "./plaid.crypto.js";
import { plaidErrorCode, PlaidServiceError } from "./plaid.errors.js";
import {
  createPlaidItemsRepository,
  type PlaidItemRow,
  type PlaidItemsRepository,
} from "./plaid-items.repository.js";
import type {
  ExchangePublicTokenBody,
  LinkTokenResponse,
  PlaidItemHealth,
  PlaidItemSummary,
} from "./plaid.schemas.js";

export type PlaidService = Readonly<{
  listItems: (userId: string) => Promise<PlaidItemSummary[]>;
  createLinkToken: (userId: string) => Promise<LinkTokenResponse>;
  exchangePublicToken: (
    userId: string,
    input: ExchangePublicTokenBody,
  ) => Promise<{ itemId: string }>;
  refreshItemBalances: (
    userId: string,
    itemId: string,
  ) => Promise<AccountBalance[]>;
  createUpdateLinkToken: (
    userId: string,
    itemId: string,
  ) => Promise<LinkTokenResponse>;
  unlinkItem: (userId: string, itemId: string) => Promise<void>;
  refreshAccountBalance: (input: {
    userId: string;
    accountId: string;
    tx: DbTransaction;
  }) => Promise<AccountBalance>;
  unlinkActiveItem: (input: {
    userId: string;
    itemId: string;
  }) => Promise<boolean>;
  revokeAllItems: (userId: string) => Promise<void>;
}>;

export type PlaidServiceDependencies = Readonly<{
  db?: Db;
  repository?: PlaidItemsRepository;
  client?: PlaidClientPort;
  cipher?: TokenCipher;
  accounts?: PlaidBalanceWriter;
  accountWriter?: PlaidAccountWriter;
  audit?: Pick<AuditLogRepository, "record">;
  withUserMutation?: UserMutationService["withUserMutation"];
  cache?: Pick<ResponseCache, "invalidateUser">;
  startPipeline?: typeof startPipelineRun;
  consume?: (
    key: string,
    config: { capacity: number; refillPerMinute: number },
  ) => void;
  logger?: Pick<typeof runtimeLogger, "warn">;
}>;

const INGESTION_FLAG = "plaid_ingestion_enabled";
const LINK_LIMIT = { capacity: 10, refillPerMinute: 2 };
const BALANCE_LIMIT = { capacity: 6, refillPerMinute: 6 };
const STALE_SYNC_THRESHOLD_MS = 72 * 60 * 60 * 1000;

function computeHealth(
  status: PlaidItemRow["status"],
  initialSyncComplete: boolean,
  lastSuccessfulSyncAt: Date | null,
): PlaidItemHealth {
  if (status === "login_required") return "needs_relink";
  if (status === "pending_expiration") return "expiring";
  if (status === "error" || status === "disconnected") return "error";
  if (!initialSyncComplete) return "ok";
  if (!lastSuccessfulSyncAt) return "stale";
  const age = Date.now() - lastSuccessfulSyncAt.getTime();
  return age > STALE_SYNC_THRESHOLD_MS ? "stale" : "ok";
}

export function createPlaidService(
  dependencies: PlaidServiceDependencies = {},
): PlaidService {
  const database = (): Db => dependencies.db ?? getDb();
  const repository =
    dependencies.repository ??
    new Proxy({} as PlaidItemsRepository, {
      get(_target, property: keyof PlaidItemsRepository) {
        const method = createPlaidItemsRepository(database())[property];
        return method;
      },
    });
  const client = dependencies.client ?? createPlaidClient();
  const cipher = dependencies.cipher ?? {
    encrypt: encryptToken,
    decrypt: decryptToken,
  };
  const accounts =
    dependencies.accounts ??
    new Proxy({} as PlaidBalanceWriter, {
      get(_target, property: keyof PlaidBalanceWriter) {
        const method = createPlaidBalanceWriter(database())[property];
        return method;
      },
    });
  const accountWriter =
    dependencies.accountWriter ??
    new Proxy({} as PlaidAccountWriter, {
      get(_target, property: keyof PlaidAccountWriter) {
        const method = createPlaidAccountWriter(database())[property];
        return method;
      },
    });
  const audit = dependencies.audit ?? auditLogRepository;
  const cache = dependencies.cache ?? createResponseCache();
  const mutate: UserMutationService["withUserMutation"] =
    dependencies.withUserMutation ??
    (<T>(userId: string, callback: (tx: DbTransaction) => Promise<T>) =>
      createWithUserMutation({ db: database(), cache })(userId, callback));
  const start = dependencies.startPipeline ?? startPipelineRun;
  const consume = dependencies.consume ?? consumeToken;
  const log = dependencies.logger ?? runtimeLogger;

  const requireEnabled = async (userId: string): Promise<void> => {
    if (!(await repository.isFeatureEnabled(INGESTION_FLAG, userId)))
      throw new PlaidServiceError(
        "FLAG_DISABLED",
        "flag",
        503,
        "Plaid ingestion is disabled",
      );
  };

  const removeRemote = async (
    item: Awaited<ReturnType<PlaidItemsRepository["findById"]>>,
  ): Promise<void> => {
    if (!item) return;
    try {
      await client.removeItem(
        cipher.decrypt({
          encrypted: item.accessTokenEncrypted,
          nonce: item.accessTokenNonce,
        }),
      );
    } catch (error) {
      await log.warn(
        { itemId: item.id, error: redactLogValue(error) },
        "Plaid item removal failed; continuing local disconnect",
      );
    }
  };

  const refreshBalances = async (
    userId: string,
    itemId: string,
    transaction?: DbTransaction,
  ): Promise<AccountBalance[]> => {
    const item = await repository.findById(itemId, userId);
    if (!item) throw new NotFoundError("plaid item");
    let remote;
    try {
      remote = await client.getBalances(
        cipher.decrypt({
          encrypted: item.accessTokenEncrypted,
          nonce: item.accessTokenNonce,
        }),
      );
    } catch (error) {
      throw new PlaidServiceError(
        plaidErrorCode(error),
        "balance",
        502,
        "Balance refresh failed",
      );
    }
    const persist = async (tx: DbTransaction): Promise<AccountBalance[]> => {
      const output: AccountBalance[] = [];
      for (const account of remote) {
        const saved = await accounts.updateBalances(
          account.account_id,
          userId,
          account.balances,
          tx,
        );
        if (!saved) continue;
        output.push({
          accountId: saved.id,
          plaidAccountId: account.account_id,
          current: account.balances.current,
          available: account.balances.available,
          limit: account.balances.limit,
          currency: account.balances.iso_currency_code,
        });
      }
      await audit.record(
        {
          userId,
          entityType: "plaid_item",
          entityId: item.id,
          action: "sync",
          source: "plaid.balance.refresh",
        },
        tx,
      );
      if (item.status !== "active" || item.errorCode || item.errorMessage) {
        await repository.markStatus(item.id, "active", null, null, tx);
        await audit.record(
          {
            userId,
            entityType: "plaid_item",
            entityId: item.id,
            action: "update",
            source: "plaid.balance.refresh",
            after: { status: "active" },
          },
          tx,
        );
      }
      return output;
    };
    return transaction ? persist(transaction) : mutate(userId, persist);
  };

  return {
    async listItems(userId) {
      return (await repository.listByUser(userId)).map((item) => {
        const initialSyncComplete = item.cursor !== null;
        return {
          id: item.id,
          institutionId: item.institutionId,
          institutionName: item.institutionName,
          status: item.status,
          errorCode: item.errorCode,
          errorMessage: item.errorMessage,
          initialSyncComplete,
          lastSuccessfulSyncAt: item.lastSyncAt
            ? item.lastSyncAt.toISOString()
            : null,
          health: computeHealth(
            item.status,
            initialSyncComplete,
            item.lastSyncAt,
          ),
        };
      });
    },
    async createLinkToken(userId) {
      consume(`plaid-link:${userId}`, LINK_LIMIT);
      await requireEnabled(userId);
      return client.createLinkToken(userId);
    },
    async exchangePublicToken(userId, input) {
      await requireEnabled(userId);
      const exchanged = await client.exchangePublicToken(input.publicToken);
      const existing = await repository.findByPlaidItemId(
        exchanged.plaidItemId,
      );
      if (existing) {
        if (existing.userId !== userId)
          throw new PlaidServiceError(
            "ITEM_OWNED_BY_OTHER_USER",
            "auth",
            409,
            "Item already linked",
          );
        return { itemId: existing.id };
      }
      const accessToken = cipher.encrypt(exchanged.accessToken);
      const created = await mutate(userId, async (tx) => {
        const row = await repository.create(
          {
            userId,
            plaidItemId: exchanged.plaidItemId,
            institutionId: input.institution.id,
            institutionName: input.institution.name,
            accessToken,
          },
          tx,
        );
        await audit.record(
          {
            userId,
            entityType: "plaid_item",
            entityId: row.id,
            action: "create",
            source: "plaid.exchange",
            after: row,
          },
          tx,
        );
        await repository.ensureUserSchedule(userId, tx);
        return row;
      });
      // /transactions/sync only ever returns accounts covered by the
      // Transactions product, so an investment-only Item (Fidelity,
      // Robinhood, etc.) would otherwise end up with zero account rows even
      // though the Item itself linked successfully. Best-effort: the Item is
      // already linked at this point, so a failure here shouldn't undo that -
      // a later balance refresh can retry.
      try {
        const plaidAccounts = await client.getAccounts(exchanged.accessToken);
        for (const account of plaidAccounts) {
          await accountWriter.upsertFromPlaid({
            userId,
            plaidItemUuid: created.id,
            account,
          });
        }
      } catch (error) {
        log.warn(
          { userId, itemId: created.id, error: redactLogValue(error) },
          "failed to backfill accounts after Plaid exchange",
        );
      }
      await start({ userId, trigger: "manual" });
      return { itemId: created.id };
    },
    async refreshItemBalances(userId, itemId) {
      consume(`plaid-balance:${userId}`, BALANCE_LIMIT);
      if (!(await repository.isFeatureEnabled(INGESTION_FLAG, userId)))
        return [];
      return refreshBalances(userId, itemId);
    },
    async createUpdateLinkToken(userId, itemId) {
      consume(`plaid-link:${userId}`, LINK_LIMIT);
      await requireEnabled(userId);
      const item = await repository.findById(itemId, userId);
      if (!item) throw new NotFoundError("plaid item");
      return client.createUpdateLinkToken(
        userId,
        cipher.decrypt({
          encrypted: item.accessTokenEncrypted,
          nonce: item.accessTokenNonce,
        }),
      );
    },
    async unlinkItem(userId, itemId) {
      const item = await repository.findById(itemId, userId);
      if (!item) throw new NotFoundError("plaid item");
      await removeRemote(item);
      await mutate(userId, async (tx) => {
        if (!(await repository.softDelete(itemId, userId, tx)))
          throw new NotFoundError("plaid item");
        await audit.record(
          {
            userId,
            entityType: "plaid_item",
            entityId: itemId,
            action: "delete",
            source: "plaid.unlink",
            before: item,
          },
          tx,
        );
      });
    },
    async refreshAccountBalance({ userId, accountId, tx }) {
      consume(`plaid-balance:${userId}`, BALANCE_LIMIT);
      const account = await accounts.findById(userId, accountId, tx);
      if (!account?.plaidItemId) throw new NotFoundError("account");
      const refreshed = await refreshBalances(userId, account.plaidItemId, tx);
      const match = refreshed.find((row) => row.accountId === accountId);
      if (!match) throw new NotFoundError("account balance");
      return match;
    },
    async unlinkActiveItem({ userId, itemId }) {
      const item = await repository.findById(itemId, userId);
      if (!item) return false;
      await removeRemote(item);
      return database().transaction(async (tx) => {
        const changed = await repository.softDelete(itemId, userId, tx);
        if (!changed) return false;
        await audit.record(
          {
            userId,
            entityType: "plaid_item",
            entityId: itemId,
            action: "delete",
            source: "accounts.remove-last-item",
            before: item,
          },
          tx,
        );
        return true;
      });
    },
    async revokeAllItems(userId) {
      const items = await repository.listByUser(userId);
      for (const item of items) {
        const accessToken = cipher.decrypt({
          encrypted: item.accessTokenEncrypted,
          nonce: item.accessTokenNonce,
        });
        await client.removeItem(accessToken);
      }
    },
  };
}
