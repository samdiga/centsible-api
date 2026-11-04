import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
  type LiabilitiesObject,
} from "plaid";
import { loadEnv, type Env } from "../../platform/config/env.js";
import type { PlaidAccountData } from "../accounts/index.js";
import type { PlaidTransactionData } from "../transactions/index.js";

/**
 * `liabilities` asks the user to share card and loan statements too, through
 * `additional_consented_products`: Plaid bills it only once /liabilities/get
 * is called (plaid.com/docs/link/update-mode), and Transactions stays the
 * only product a bank must support for the link to work.
 */
export type LinkTokenOptions = Readonly<{ liabilities?: boolean }>;

export type PlaidClientPort = Readonly<{
  createLinkToken: (
    userId: string,
    options?: LinkTokenOptions,
  ) => Promise<{ linkToken: string; expiration: string }>;
  exchangePublicToken: (
    publicToken: string,
  ) => Promise<{ accessToken: string; plaidItemId: string }>;
  createUpdateLinkToken: (
    userId: string,
    accessToken: string,
    options?: LinkTokenOptions,
  ) => Promise<{ linkToken: string; expiration: string }>;
  /**
   * All accounts on this Item, regardless of which products were
   * authorized at Link time. `/transactions/sync` only ever returns
   * accounts covered by the Transactions product, so an investment-only
   * Item (Fidelity, Robinhood, etc.) never gets an account row otherwise -
   * this exists specifically to backfill those right after exchange.
   */
  getAccounts: (accessToken: string) => Promise<PlaidAccountData[]>;
  getLiabilities: (accessToken: string) => Promise<LiabilitiesObject>;
  /**
   * When Plaid last reached the bank for this Item's transactions
   * (/item/get `status.transactions.last_successful_update`, which "will
   * update each time Plaid successfully connects with the institution").
   * Null when Plaid doesn't say.
   */
  getBankLastUpdatedAt: (accessToken: string) => Promise<Date | null>;
  /** Products the user has consented to share on this Item (/item/get). */
  getConsentedProducts: (accessToken: string) => Promise<string[]>;
  removeItem: (accessToken: string) => Promise<void>;
  syncTransactions: (
    accessToken: string,
    cursor?: string,
  ) => Promise<PlaidSyncPage>;
}>;

export type PlaidSyncTransaction = PlaidTransactionData & {
  account_id: string;
};
export type PlaidSyncPage = Readonly<{
  accounts: PlaidAccountData[];
  added: PlaidSyncTransaction[];
  modified: PlaidSyncTransaction[];
  removed: Array<{ transaction_id?: string }>;
  nextCursor: string;
  hasMore: boolean;
  rawPayload: Record<string, unknown>;
}>;

const DEVELOPMENT_URL = "https://development.plaid.com";

function basePath(environment: Env["PLAID_ENV"]): string {
  if (environment === "production") {
    if (!PlaidEnvironments.production)
      throw new Error("Plaid production environment is unavailable");
    return PlaidEnvironments.production;
  }
  if (environment === "development") return DEVELOPMENT_URL;
  if (!PlaidEnvironments.sandbox)
    throw new Error("Plaid sandbox environment is unavailable");
  return PlaidEnvironments.sandbox;
}

/** Adapts the Plaid SDK to the small surface used by this domain. */
export function createPlaidClient(configuration?: () => Env): PlaidClientPort {
  let client: PlaidApi | undefined;
  const runtime = (): { client: PlaidApi; env: Env } => {
    const env = (configuration ?? loadEnv)();
    if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET)
      throw new Error("Plaid credentials are required");
    client ??= new PlaidApi(
      new Configuration({
        basePath: basePath(env.PLAID_ENV),
        baseOptions: {
          headers: {
            "PLAID-CLIENT-ID": env.PLAID_CLIENT_ID,
            "PLAID-SECRET": env.PLAID_SECRET,
            "Plaid-Version": "2020-09-14",
          },
        },
      }),
    );
    return { client, env };
  };
  return {
    async createLinkToken(userId, options = {}) {
      const { client: plaid, env } = runtime();
      const response = await plaid.linkTokenCreate({
        user: { client_user_id: userId },
        client_name: "Centsible",
        products: [Products.Transactions],
        ...(options.liabilities
          ? { additional_consented_products: [Products.Liabilities] }
          : {}),
        country_codes: [CountryCode.Us],
        language: "en",
        ...(env.WEBHOOK_BASE_URL
          ? { webhook: `${env.WEBHOOK_BASE_URL}/plaid/webhook` }
          : {}),
        ...(env.PLAID_REDIRECT_URI
          ? { redirect_uri: env.PLAID_REDIRECT_URI }
          : {}),
      });
      return {
        linkToken: response.data.link_token,
        expiration: response.data.expiration,
      };
    },
    async exchangePublicToken(publicToken) {
      const response = await runtime().client.itemPublicTokenExchange({
        public_token: publicToken,
      });
      return {
        accessToken: response.data.access_token,
        plaidItemId: response.data.item_id,
      };
    },
    async createUpdateLinkToken(userId, accessToken, options = {}) {
      const { client: plaid, env } = runtime();
      const response = await plaid.linkTokenCreate({
        user: { client_user_id: userId },
        client_name: "Centsible",
        country_codes: [CountryCode.Us],
        language: "en",
        access_token: accessToken,
        update: { account_selection_enabled: true },
        ...(options.liabilities
          ? { additional_consented_products: [Products.Liabilities] }
          : {}),
        ...(env.WEBHOOK_BASE_URL
          ? { webhook: `${env.WEBHOOK_BASE_URL}/plaid/webhook` }
          : {}),
        ...(env.PLAID_REDIRECT_URI
          ? { redirect_uri: env.PLAID_REDIRECT_URI }
          : {}),
      });
      return {
        linkToken: response.data.link_token,
        expiration: response.data.expiration,
      };
    },
    async getAccounts(accessToken) {
      const response = await runtime().client.accountsGet({
        access_token: accessToken,
      });
      return response.data.accounts as PlaidAccountData[];
    },
    async getBankLastUpdatedAt(accessToken) {
      const response = await runtime().client.itemGet({
        access_token: accessToken,
      });
      const value = response.data.status?.transactions?.last_successful_update;
      return value ? new Date(value) : null;
    },
    async getConsentedProducts(accessToken) {
      const response = await runtime().client.itemGet({
        access_token: accessToken,
      });
      return response.data.item.consented_products ?? [];
    },
    async getLiabilities(accessToken) {
      const response = await runtime().client.liabilitiesGet({
        access_token: accessToken,
      });
      return response.data.liabilities;
    },
    async removeItem(accessToken) {
      await runtime().client.itemRemove({ access_token: accessToken });
    },
    async syncTransactions(accessToken, cursor) {
      const response = await runtime().client.transactionsSync({
        access_token: accessToken,
        ...(cursor ? { cursor } : {}),
        count: 500,
      });
      const data = response.data;
      return {
        accounts: data.accounts as PlaidAccountData[],
        added: data.added as unknown as PlaidSyncTransaction[],
        modified: data.modified as unknown as PlaidSyncTransaction[],
        removed: data.removed,
        nextCursor: data.next_cursor,
        hasMore: data.has_more,
        rawPayload: data as unknown as Record<string, unknown>,
      };
    },
  };
}
