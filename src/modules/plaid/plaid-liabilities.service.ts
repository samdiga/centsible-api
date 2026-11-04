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
  createPlaidAccountDataWriter,
  type PlaidAccountDataWriter,
} from "../accounts/index.js";
import { createPlaidClient, type PlaidClientPort } from "./plaid.client.js";
import { decryptToken, type TokenCipher } from "./plaid.crypto.js";
import { plaidErrorDetails } from "./plaid.errors.js";
import {
  createPlaidItemsRepository,
  type PlaidItemRow,
  type PlaidItemsRepository,
} from "./plaid-items.repository.js";

/** Off switch for every Plaid call that involves Liabilities; on when unset. */
export const LIABILITIES_FLAG = "plaid_liabilities_enabled";

export type LiabilitiesSyncResult = Readonly<{
  accountsUpdated: number;
  unavailableReason: string | null;
  /** The connection has no card or loan, so Plaid wasn't asked. */
  skipped?: boolean;
}>;

/**
 * Plaid errors that say what the bank will share, as opposed to a passing
 * problem (a login, a rate limit, data not ready yet, Plaid's own failure)
 * that leaves the connection's recorded status alone and only counts toward
 * `LIABILITIES_UNAVAILABLE_AFTER`.
 */
const STATUS_BY_ERROR: Readonly<
  Record<string, NonNullable<PlaidItemRow["liabilitiesStatus"]>>
> = {
  ADDITIONAL_CONSENT_REQUIRED: "consent_required",
  PRODUCTS_NOT_SUPPORTED: "not_supported",
  NO_LIABILITY_ACCOUNTS: "not_supported",
};

/**
 * Failed fetches in a row before the app says the bank isn't sharing
 * statements: about 18 hours at the 6-hourly Liabilities cadence.
 */
export const LIABILITIES_UNAVAILABLE_AFTER = 3;

export type PlaidLiabilitiesService = Readonly<{
  syncItemLiabilities: (
    userId: string,
    itemId: string,
  ) => Promise<LiabilitiesSyncResult>;
}>;

type Dependencies = Readonly<{
  repository?: Pick<
    PlaidItemsRepository,
    | "findById"
    | "isFeatureEnabled"
    | "hasLiabilityAccounts"
    | "setLiabilitiesStatus"
    | "recordLiabilitiesFailure"
  >;
  client?: Pick<PlaidClientPort, "getLiabilities" | "getConsentedProducts">;
  cipher?: Pick<TokenCipher, "decrypt">;
  accounts?: Pick<PlaidAccountDataWriter, "updateLiabilities">;
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
    dependencies.accounts ?? createPlaidAccountDataWriter(database());
  const audit = dependencies.audit ?? auditLogRepository;
  const mutate: UserMutationService["withUserMutation"] =
    dependencies.withUserMutation ??
    (<T>(userId: string, callback: (tx: DbTransaction) => Promise<T>) =>
      createWithUserMutation({ db: database(), cache: createResponseCache() })(
        userId,
        callback,
      ));

  /**
   * Best effort: a failed /item/get keeps the recorded consent as it is,
   * and the next failed fetch asks again.
   */
  async function liabilitiesConsented(accessToken: string): Promise<boolean> {
    try {
      return (await client.getConsentedProducts(accessToken)).includes(
        "liabilities",
      );
    } catch {
      return false;
    }
  }

  return {
    async syncItemLiabilities(userId, itemId) {
      if (
        !(await repository.isFeatureEnabled(
          LIABILITIES_FLAG,
          userId,
        ))
      )
        return { accountsUpdated: 0, unavailableReason: "FLAG_DISABLED" };
      const item = await repository.findById(itemId, userId);
      if (!item)
        return { accountsUpdated: 0, unavailableReason: "ITEM_NOT_FOUND" };
      // Liabilities is billed per connection, so one with only checking,
      // savings or investments is never asked.
      if (!(await repository.hasLiabilityAccounts(item.id, userId)))
        return { accountsUpdated: 0, unavailableReason: null, skipped: true };
      let accessToken: string | undefined;
      let liabilities: LiabilitiesObject;
      try {
        accessToken = cipher.decrypt({
          encrypted: item.accessTokenEncrypted,
          nonce: item.accessTokenNonce,
        });
        liabilities = await client.getLiabilities(accessToken);
      } catch (error) {
        const plaid = plaidErrorDetails(error);
        const status = STATUS_BY_ERROR[plaid.errorCode];
        // A re-approval that Plaid granted can still be followed by a fetch
        // that fails for another reason; "re-approve" would then never clear.
        const clearConsent =
          !status &&
          accessToken !== undefined &&
          item.liabilitiesStatus === "consent_required" &&
          (await liabilitiesConsented(accessToken));
        // Kept in the audit log, not the server log, whose data is cut to 50
        // characters: a Plaid support ticket needs the request id.
        await mutate(userId, async (tx: DbTransaction) => {
          if (status)
            await repository.setLiabilitiesStatus(item.id, userId, status, tx);
          else
            await repository.recordLiabilitiesFailure(
              item.id,
              userId,
              { clearConsent },
              tx,
            );
          await audit.record(
            {
              userId,
              entityType: "plaid_item",
              entityId: item.id,
              action: "sync",
              source: "plaid.liabilities.failed",
              after: { plaid, ...(clearConsent ? { clearedConsent: true } : {}) },
            },
            tx,
          );
        });
        return { accountsUpdated: 0, unavailableReason: plaid.errorCode };
      }
      return mutate(userId, async (tx: DbTransaction) => {
        await repository.setLiabilitiesStatus(
          item.id,
          userId,
          "available",
          tx,
        );
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
                lastPaymentCents: cents(credit.last_payment_amount),
                lastPaymentDate: credit.last_payment_date ?? null,
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
