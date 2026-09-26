import { getDb } from "../../platform/database/client.js";
import type { Db, DbTransaction } from "../../platform/database/types.js";
import { auditLogRepository } from "../../platform/database/audit-log.repository.js";
import { createResponseCache } from "../../platform/cache/response-cache.js";
import {
  createWithUserMutation,
  type UserMutationService,
} from "../../platform/cache/user-revisions.repository.js";
import {
  createPlaidAccountWriter,
  type PlaidAccountWriter,
} from "../accounts/index.js";
import {
  createPlaidTransactionWriter,
  rulePatch,
  type PlaidTransactionWriter,
} from "../transactions/index.js";
import {
  createRulesRepository,
  matchRules,
  ruleForMatching,
  type RuleRepository,
} from "../rules/index.js";
import { createPlaidClient, type PlaidClientPort } from "./plaid.client.js";
import { decryptToken, type TokenCipher } from "./plaid.crypto.js";
import { plaidErrorCode, PlaidServiceError } from "./plaid.errors.js";
import {
  createPlaidItemsRepository,
  type PlaidItemsRepository,
} from "./plaid-items.repository.js";
import {
  createPlaidRawImportsRepository,
  type PlaidRawImportsRepository,
} from "./plaid-raw-imports.repository.js";
import {
  transactionCategorizer,
  type TransactionCategorizer,
} from "../transactions/auto-categorize.js";

export type PlaidSyncResult = Readonly<{
  added: number;
  modified: number;
  removed: number;
  pages: number;
  /** Transactions not stored because their account was removed by the user. */
  skippedRemovedAccount: number;
}>;

export type PlaidSyncService = Readonly<{
  syncItem: (userId: string, itemId: string) => Promise<PlaidSyncResult>;
}>;

type Dependencies = Readonly<{
  db?: Db;
  items?: Pick<
    PlaidItemsRepository,
    | "findByUuid"
    | "isFeatureEnabled"
    | "advanceCursor"
    | "markSynced"
    | "markStatus"
  >;
  client?: Pick<PlaidClientPort, "syncTransactions">;
  cipher?: Pick<TokenCipher, "decrypt">;
  accounts?: PlaidAccountWriter;
  transactions?: Pick<
    PlaidTransactionWriter,
    | "upsertManyFromPlaid"
    | "softDeleteByPlaidIds"
    | "applyRuleMatch"
    | "addTransactionTags"
  >;
  rules?: Pick<RuleRepository, "listActiveRules">;
  rawImports?: Pick<PlaidRawImportsRepository, "record">;
  audit?: typeof auditLogRepository;
  transaction?: <T>(callback: (tx: DbTransaction) => Promise<T>) => Promise<T>;
  withUserMutation?: UserMutationService["withUserMutation"];
  /** Best-effort hook after an item's status changes (e.g. enqueue sync-health alerts). */
  onItemStatusChanged?: (userId: string) => Promise<void>;
  /** Categorises new transactions no rule categorised (history, then bank mapping). */
  categorizer?: TransactionCategorizer;
}>;

/** Tolerates app/database clock skew when telling new rows from adopted ones. */
const NEW_ROW_CLOCK_SLACK_MS = 5 * 60 * 1000;

export function createPlaidSyncService(
  dependencies: Dependencies = {},
): PlaidSyncService {
  const database = (): Db => dependencies.db ?? getDb();
  const items = dependencies.items ?? createPlaidItemsRepository(database());
  const client = dependencies.client ?? createPlaidClient();
  const cipher = dependencies.cipher ?? { decrypt: decryptToken };
  const accounts =
    dependencies.accounts ?? createPlaidAccountWriter(database());
  const transactions =
    dependencies.transactions ?? createPlaidTransactionWriter(database());
  const rules = dependencies.rules ?? createRulesRepository(database());
  const categorizer = dependencies.categorizer ?? transactionCategorizer;
  const rawImports =
    dependencies.rawImports ?? createPlaidRawImportsRepository(database());
  const audit = dependencies.audit ?? auditLogRepository;
  const transaction =
    dependencies.transaction ??
    (<T>(callback: (tx: DbTransaction) => Promise<T>) =>
      database().transaction(callback));
  const mutate: UserMutationService["withUserMutation"] =
    dependencies.withUserMutation ??
    (<T>(userId: string, callback: (tx: DbTransaction) => Promise<T>) =>
      createWithUserMutation({
        db: database(),
        cache: createResponseCache(),
      })(userId, callback));
  const statusChanged = async (userId: string): Promise<void> => {
    try {
      await dependencies.onItemStatusChanged?.(userId);
    } catch {
      // Alerts are re-derived by the daily sweep; never fail a sync over this.
    }
  };

  return {
    async syncItem(userId, itemId) {
      const item = await items.findByUuid(itemId);
      if (!item || item.userId !== userId)
        throw new PlaidServiceError(
          "UNKNOWN_ITEM",
          "sync",
          404,
          "Plaid item not found",
        );
      if (!(await items.isFeatureEnabled("plaid_ingestion_enabled", userId)))
        return {
          added: 0,
          modified: 0,
          removed: 0,
          pages: 0,
          skippedRemovedAccount: 0,
        };
      const accessToken = cipher.decrypt({
        encrypted: item.accessTokenEncrypted,
        nonce: item.accessTokenNonce,
      });
      const activeRules = (await rules.listActiveRules(userId)).map(
        ruleForMatching,
      );
      let cursor = item.cursor ?? undefined;
      let priorCursor = item.cursor ?? null;
      let completed = false;
      const result = {
        added: 0,
        modified: 0,
        removed: 0,
        pages: 0,
        skippedRemovedAccount: 0,
      };
      for (;;) {
        let page;
        try {
          page = await client.syncTransactions(accessToken, cursor);
        } catch (error) {
          const code = plaidErrorCode(error);
          const status =
            code === "ITEM_LOGIN_REQUIRED"
              ? "login_required"
              : code === "PENDING_EXPIRATION"
                ? "pending_expiration"
                : "error";
          await items.markStatus(item.id, status, code, "Plaid sync failed");
          if (item.status !== status) await statusChanged(userId);
          throw new PlaidServiceError(code, "sync", 502, "Plaid sync failed");
        }
        const advanced = await transaction(async (tx) => {
          await rawImports.record(
            {
              userId,
              plaidItemId: item.id,
              endpoint: "transactions/sync",
              ...(cursor ? { cursor } : {}),
              payload: page.rawPayload,
            },
            tx,
          );
          const accountMap = new Map<string, string>();
          // Accounts the user removed while the login stays connected: Plaid
          // keeps sending their transactions, and storing them only piles up
          // hidden rows. Their soft-deleted row stays (it's what keeps the
          // account hidden); their transactions are skipped.
          const removedAccounts = new Set<string>();
          for (const account of page.accounts) {
            const saved = await accounts.upsertFromPlaid(
              { userId, plaidItemUuid: item.id, account },
              tx,
            );
            accountMap.set(account.account_id, saved.id);
            if (saved.deletedAt) removedAccounts.add(account.account_id);
          }
          const allChanged = [...page.added, ...page.modified];
          const missingAccountIds = [
            ...new Set(
              allChanged
                .map((entry) => entry.account_id)
                .filter((id) => !accountMap.has(id)),
            ),
          ];
          for (const account of await accounts.findByPlaidAccountIds(
            missingAccountIds,
            userId,
            tx,
          )) {
            if (!account.plaidAccountId) continue;
            accountMap.set(account.plaidAccountId, account.id);
            if (account.deletedAt) removedAccounts.add(account.plaidAccountId);
          }
          const changed = allChanged.filter(
            (entry) => !removedAccounts.has(entry.account_id),
          );
          result.skippedRemovedAccount += allChanged.length - changed.length;
          // Known before this page is written: anything else is newly
          // imported (or adopted after a relink, which the age check below
          // excludes), and only new transactions get auto-categorised.
          const importStartedAt = Date.now();
          const alreadyKnown = await categorizer.existingPlaidIds(
            changed.map((entry) => entry.transaction_id),
            userId,
            tx,
          );
          const savedTransactions = await transactions.upsertManyFromPlaid(
            changed.map((entry) => {
              const accountId = accountMap.get(entry.account_id);
              if (!accountId)
                throw new PlaidServiceError(
                  "UNKNOWN_ACCOUNT",
                  "sync",
                  500,
                  "Transaction references unknown account",
                );
              return { userId, accountId, txn: entry };
            }),
            tx,
          );
          const categorisedByRule = new Set<string>();
          for (const row of savedTransactions) {
            if (row.userCategoryOverride || activeRules.length === 0) continue;
            const rule = matchRules(
              {
                merchantName: row.merchantName,
                name: row.name,
                amount: row.amount,
                accountId: row.accountId,
              },
              activeRules,
            );
            const patch = rulePatch(row, rule ?? undefined);
            if (patch.categoryId !== undefined) categorisedByRule.add(row.id);
            if (Object.keys(patch).length > 0)
              await transactions.applyRuleMatch(row.id, userId, patch, tx);
            if (rule?.actionAddTagIds && rule.actionAddTagIds.length > 0)
              await transactions.addTransactionTags(
                row.id,
                userId,
                rule.actionAddTagIds,
                tx,
              );
          }
          const freshlyImported = savedTransactions.filter(
            (row) =>
              !row.userCategoryOverride &&
              row.categoryId === null &&
              !categorisedByRule.has(row.id) &&
              row.plaidTransactionId !== null &&
              !alreadyKnown.has(row.plaidTransactionId) &&
              row.createdAt.getTime() >=
                importStartedAt - NEW_ROW_CLOCK_SLACK_MS,
          );
          if (freshlyImported.length > 0)
            await categorizer.categorize(userId, freshlyImported, tx);
          const removedIds = page.removed
            .map((entry) => entry.transaction_id)
            .filter((id): id is string => typeof id === "string" && !!id);
          await transactions.softDeleteByPlaidIds(removedIds, userId, tx);
          return items.advanceCursor(item.id, priorCursor, page.nextCursor, tx);
        });
        result.added += page.added.length;
        result.modified += page.modified.length;
        result.removed += page.removed.filter(
          (entry) => typeof entry.transaction_id === "string",
        ).length;
        result.pages += 1;
        if (!advanced) break;
        priorCursor = page.nextCursor;
        cursor = page.nextCursor;
        if (!page.hasMore) {
          completed = true;
          break;
        }
      }
      let recovered = false;
      await mutate(userId, async (tx) => {
        if (completed) {
          await items.markSynced(item.id, tx);
          if (item.status !== "active" || item.errorCode || item.errorMessage) {
            recovered = true;
            await items.markStatus(item.id, "active", null, null, tx);
            await audit.record(
              {
                userId,
                entityType: "plaid_item",
                entityId: item.id,
                action: "update",
                source: "plaid.sync",
                after: { status: "active" },
              },
              tx,
            );
          }
        }
        await audit.record(
          {
            userId,
            entityType: "plaid_item",
            entityId: item.id,
            action: "sync",
            source: "plaid.sync",
            after: result,
          },
          tx,
        );
      });
      if (recovered) await statusChanged(userId);
      return result;
    },
  };
}
