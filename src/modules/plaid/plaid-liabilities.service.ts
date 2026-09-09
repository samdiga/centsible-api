import type { LiabilitiesObject } from "plaid";
import { getDb } from "../../platform/database/client.js";
import type { DbTransaction } from "../../platform/database/types.js";
import { auditLogRepository } from "../../platform/database/audit-log.repository.js";
import { createResponseCache } from "../../platform/cache/response-cache.js";
import {
  createWithUserMutation,
  type UserMutationService,
} from "../../platform/cache/user-revisions.repository.js";
import {
  createPlaidBalanceWriter,
  type PlaidBalanceWriter,
} from "../accounts/index.js";
import { createPlaidClient, type PlaidClientPort } from "./plaid.client.js";
import { decryptToken, type TokenCipher } from "./plaid.crypto.js";
import { plaidErrorCode } from "./plaid.errors.js";
import {
  createPlaidItemsRepository,
  type PlaidItemsRepository,
} from "./plaid-items.repository.js";

export type LiabilitiesSyncResult = Readonly<{
  accountsUpdated: number;
  unavailableReason: string | null;
}>;

export type PlaidLiabilitiesService = Readonly<{
  syncItemLiabilities: (
    userId: string,
    itemId: string,
  ) => Promise<LiabilitiesSyncResult>;
}>;

type Dependencies = Readonly<{
  repository?: Pick<PlaidItemsRepository, "findById" | "isFeatureEnabled">;
  client?: Pick<PlaidClientPort, "getLiabilities">;
  cipher?: Pick<TokenCipher, "decrypt">;
  accounts?: Pick<PlaidBalanceWriter, "updateLiabilities">;
  withUserMutation?: UserMutationService["withUserMutation"];
  audit?: typeof auditLogRepository;
}>;

function cents(value: number | null | undefined): bigint | null {
  if (value == null || !Number.isFinite(value)) return null;
  return BigInt(Math.round(value * 100));
}

export function createPlaidLiabilitiesService(
  dependencies: Dependencies = {},
): PlaidLiabilitiesService {
  const database = () => getDb();
  const repository =
    dependencies.repository ?? createPlaidItemsRepository(database());
  const client = dependencies.client ?? createPlaidClient();
  const cipher = dependencies.cipher ?? { decrypt: decryptToken };
  const accounts =
    dependencies.accounts ?? createPlaidBalanceWriter(database());
  const audit = dependencies.audit ?? auditLogRepository;
  const mutate: UserMutationService["withUserMutation"] =
    dependencies.withUserMutation ??
    (<T>(userId: string, callback: (tx: DbTransaction) => Promise<T>) =>
      createWithUserMutation({ db: database(), cache: createResponseCache() })(
        userId,
        callback,
      ));

  return {
    async syncItemLiabilities(userId, itemId) {
      if (
        !(await repository.isFeatureEnabled(
          "plaid_liabilities_enabled",
          userId,
        ))
      )
        return { accountsUpdated: 0, unavailableReason: "FLAG_DISABLED" };
      const item = await repository.findById(itemId, userId);
      if (!item)
        return { accountsUpdated: 0, unavailableReason: "ITEM_NOT_FOUND" };
      let liabilities: LiabilitiesObject;
      try {
        liabilities = await client.getLiabilities(
          cipher.decrypt({
            encrypted: item.accessTokenEncrypted,
            nonce: item.accessTokenNonce,
          }),
        );
      } catch (error) {
        return {
          accountsUpdated: 0,
          unavailableReason: plaidErrorCode(error),
        };
      }
      return mutate(userId, async (tx: DbTransaction) => {
        let updated = 0;
        for (const credit of liabilities.credit ?? []) {
          if (!credit.account_id) continue;
          const purchaseApr = credit.aprs?.find(
            (entry) => entry.apr_type === "purchase_apr",
          );
          if (
            await accounts.updateLiabilities(
              userId,
              credit.account_id,
              {
                apr: purchaseApr?.apr_percentage ?? null,
                minimumPayment: cents(credit.minimum_payment_amount),
                paymentDueDate: credit.next_payment_due_date ?? null,
                statementBalance: cents(credit.last_statement_balance),
                statementDate: credit.last_statement_issue_date ?? null,
              },
              tx,
            )
          )
            updated += 1;
        }
        for (const student of liabilities.student ?? []) {
          if (!student.account_id) continue;
          if (
            await accounts.updateLiabilities(
              userId,
              student.account_id,
              {
                apr: student.interest_rate_percentage ?? null,
                minimumPayment: cents(student.minimum_payment_amount),
                paymentDueDate: student.next_payment_due_date ?? null,
                originationDate: student.origination_date ?? null,
                maturityDate: student.expected_payoff_date ?? null,
              },
              tx,
            )
          )
            updated += 1;
        }
        for (const mortgage of liabilities.mortgage ?? []) {
          if (!mortgage.account_id) continue;
          if (
            await accounts.updateLiabilities(
              userId,
              mortgage.account_id,
              {
                apr: mortgage.interest_rate?.percentage ?? null,
                paymentDueDate: mortgage.next_payment_due_date ?? null,
                originationDate: mortgage.origination_date ?? null,
                maturityDate: mortgage.maturity_date ?? null,
              },
              tx,
            )
          )
            updated += 1;
        }
        await audit.record(
          {
            userId,
            entityType: "plaid_item",
            entityId: item.id,
            action: "sync",
            source: "plaid.liabilities.sync",
          },
          tx,
        );
        return { accountsUpdated: updated, unavailableReason: null };
      });
    },
  };
}
