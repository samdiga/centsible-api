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
  createPlaidAccountDataWriter,
  mapAccountSubtype,
  mapAccountType,
  type PlaidAccountWriter,
  type PlaidAccountDataWriter,
} from "../accounts/index.js";
import type { AccountBalance } from "../accounts/accounts.schemas.js";
import { startPipelineRun } from "../pipeline/pipeline.service.js";
import { createPlaidClient, type PlaidClientPort } from "./plaid.client.js";
import { LIABILITIES_FLAG } from "./plaid-liabilities.service.js";
import {
  decryptToken,
  encryptToken,
  type TokenCipher,
} from "./plaid.crypto.js";
import {
  DuplicateItemError,
  plaidErrorCode,
  PlaidServiceError,
} from "./plaid.errors.js";
import { computeItemHealth, isBankNotRefreshing } from "./plaid-health.js";
import {
  createPlaidItemsRepository,
  type PlaidItemsRepository,
} from "./plaid-items.repository.js";
import type {
  ExchangePublicTokenBody,
  LinkTokenResponse,
  PlaidItemSummary,
  RestoredAccount,
} from "./plaid.schemas.js";

export type PlaidService = Readonly<{
  listItems: (userId: string) => Promise<PlaidItemSummary[]>;
  createLinkToken: (userId: string) => Promise<LinkTokenResponse>;
  exchangePublicToken: (
    userId: string,
    input: ExchangePublicTokenBody,
  ) => Promise<{ itemId: string; restoredAccounts: RestoredAccount[] }>;
  refreshCachedAccountsForItem: (
    userId: string,
    itemId: string,
  ) => Promise<AccountBalance[]>;
  createUpdateLinkToken: (
    userId: string,
    itemId: string,
  ) => Promise<LinkTokenResponse>;
  unlinkItem: (userId: string, itemId: string) => Promise<void>;
  refreshCachedAccount: (input: {
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
  accounts?: PlaidAccountDataWriter;
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
const ACCOUNT_REFRESH_LIMIT = { capacity: 6, refillPerMinute: 6 };

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
    new Proxy({} as PlaidAccountDataWriter, {
      get(_target, property: keyof PlaidAccountDataWriter) {
        const method = createPlaidAccountDataWriter(database())[property];
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

  const refreshCachedAccounts = async (
    userId: string,
    itemId: string,
    transaction?: DbTransaction,
  ): Promise<AccountBalance[]> => {
    const item = await repository.findById(itemId, userId);
    if (!item) throw new NotFoundError("plaid item");
    let remote;
    try {
      remote = await client.getAccounts(
        cipher.decrypt({
          encrypted: item.accessTokenEncrypted,
          nonce: item.accessTokenNonce,
        }),
      );
    } catch (error) {
      throw new PlaidServiceError(
        plaidErrorCode(error),
        "accounts",
        502,
        "Cached account refresh failed",
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
          current: account.balances.current ?? null,
          available: account.balances.available ?? null,
          limit: account.balances.limit ?? null,
          currency: account.balances.iso_currency_code ?? null,
        });
      }
      await audit.record(
        {
          userId,
          entityType: "plaid_item",
          entityId: item.id,
          action: "sync",
          source: "plaid.accounts.cached_refresh",
        },
        tx,
      );
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
          health: computeItemHealth(item),
          liabilitiesConsentRequired:
            item.liabilitiesStatus === "consent_required",
          bankLastUpdatedAt: item.bankLastUpdatedAt
            ? item.bankLastUpdatedAt.toISOString()
            : null,
          bankNotRefreshing: isBankNotRefreshing(item),
        };
      });
    },
    async createLinkToken(userId) {
      consume(`plaid-link:${userId}`, LINK_LIMIT);
      await requireEnabled(userId);
      return client.createLinkToken(userId, {
        liabilities: await repository.isFeatureEnabled(
          LIABILITIES_FLAG,
          userId,
        ),
      });
    },
    async exchangePublicToken(userId, input) {
      await requireEnabled(userId);
      // Checked before the exchange: an un-exchanged public token creates no
      // access token for us to hold, and Plaid says not to exchange one for
      // an Item the user already has. Accounts without a mask can't be told
      // apart, so they never block.
      const incoming = (input.accounts ?? []).flatMap((account) =>
        account.mask
          ? [
              {
                mask: account.mask,
                type: mapAccountType(account.type),
                subtype: account.subtype
                  ? mapAccountSubtype(account.subtype)
                  : null,
              },
            ]
          : [],
      );
      const duplicates = await repository.findLiveAccountMatches(
        userId,
        input.institution.id,
        incoming,
      );
      if (duplicates.length) {
        const itemId = duplicates[0]!.itemId;
        throw new DuplicateItemError({
          itemId,
          institutionName: duplicates[0]!.institutionName,
          accounts: duplicates
            .filter((row) => row.itemId === itemId)
            .map((row) => ({ id: row.accountId, name: row.name, mask: row.mask })),
        });
      }
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
        return { itemId: existing.id, restoredAccounts: [] };
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
      // a later cached account sync can retry.
      const restoredAccounts: RestoredAccount[] = [];
      try {
        const plaidAccounts = await client.getAccounts(exchanged.accessToken);
        for (const account of plaidAccounts) {
          const row = await accountWriter.upsertFromPlaid({
            userId,
            plaidItemUuid: created.id,
            account,
          });
          // A brand-new Item can only reuse an account row that existed
          // before it — one the user removed earlier and this link took over.
          if (row.createdAt.getTime() < created.createdAt.getTime())
            restoredAccounts.push({
              id: row.id,
              name: row.name,
              mask: row.mask,
            });
        }
      } catch (error) {
        log.warn(
          { userId, itemId: created.id, error: redactLogValue(error) },
          "failed to backfill accounts after Plaid exchange",
        );
      }
      await start({ userId, trigger: "manual" });
      return { itemId: created.id, restoredAccounts };
    },
    async refreshCachedAccountsForItem(userId, itemId) {
      consume(`plaid-accounts:${userId}`, ACCOUNT_REFRESH_LIMIT);
      if (!(await repository.isFeatureEnabled(INGESTION_FLAG, userId)))
        return [];
      const accounts = await refreshCachedAccounts(userId, itemId);
      // The app refreshes a connection right after update mode. When that was
      // the user re-approving statement sharing, fetch Liabilities now rather
      // than leaving "re-approve" up until the next scheduled sync.
      if (
        (await repository.findById(itemId, userId))?.liabilitiesStatus ===
        "consent_required"
      )
        await start({ userId, trigger: "manual" });
      return accounts;
    },
    async createUpdateLinkToken(userId, itemId) {
      consume(`plaid-link:${userId}`, LINK_LIMIT);
      await requireEnabled(userId);
      const item = await repository.findById(itemId, userId);
      if (!item) throw new NotFoundError("plaid item");
      // Only a connection the bank said lacks consent asks for Liabilities:
      // a plain reconnect (a fixed login, a review of shared accounts) stays
      // exactly what it was.
      return client.createUpdateLinkToken(
        userId,
        cipher.decrypt({
          encrypted: item.accessTokenEncrypted,
          nonce: item.accessTokenNonce,
        }),
        {
          liabilities:
            item.liabilitiesStatus === "consent_required" &&
            (await repository.isFeatureEnabled(LIABILITIES_FLAG, userId)),
        },
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
    async refreshCachedAccount({ userId, accountId, tx }) {
      consume(`plaid-accounts:${userId}`, ACCOUNT_REFRESH_LIMIT);
      const account = await accounts.findById(userId, accountId, tx);
      if (!account?.plaidItemId) throw new NotFoundError("account");
      const refreshed = await refreshCachedAccounts(
        userId,
        account.plaidItemId,
        tx,
      );
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
