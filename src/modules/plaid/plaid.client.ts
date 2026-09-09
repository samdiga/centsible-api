import {
  Configuration,
  CountryCode,
  PlaidApi,
  PlaidEnvironments,
  Products,
  type LiabilitiesObject,
} from "plaid";
import { loadEnv, type Env } from "../../platform/config/env.js";

export type PlaidBalanceAccount = Readonly<{
  account_id: string;
  balances: {
    current: number | null;
    available: number | null;
    limit: number | null;
    iso_currency_code: string | null;
  };
}>;

export type PlaidClientPort = Readonly<{
  createLinkToken: (
    userId: string,
  ) => Promise<{ linkToken: string; expiration: string }>;
  exchangePublicToken: (
    publicToken: string,
  ) => Promise<{ accessToken: string; plaidItemId: string }>;
  createUpdateLinkToken: (
    userId: string,
    accessToken: string,
  ) => Promise<{ linkToken: string; expiration: string }>;
  getBalances: (accessToken: string) => Promise<PlaidBalanceAccount[]>;
  getLiabilities: (accessToken: string) => Promise<LiabilitiesObject>;
  removeItem: (accessToken: string) => Promise<void>;
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
    async createLinkToken(userId) {
      const { client: plaid, env } = runtime();
      const response = await plaid.linkTokenCreate({
        user: { client_user_id: userId },
        client_name: "Centsible",
        products: [Products.Transactions],
        optional_products: [Products.Liabilities],
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
    async createUpdateLinkToken(userId, accessToken) {
      const { client: plaid, env } = runtime();
      const response = await plaid.linkTokenCreate({
        user: { client_user_id: userId },
        client_name: "Centsible",
        country_codes: [CountryCode.Us],
        language: "en",
        access_token: accessToken,
        ...(env.WEBHOOK_BASE_URL
          ? { webhook: `${env.WEBHOOK_BASE_URL}/plaid/webhook` }
          : {}),
      });
      return {
        linkToken: response.data.link_token,
        expiration: response.data.expiration,
      };
    },
    async getBalances(accessToken) {
      const response = await runtime().client.accountsBalanceGet({
        access_token: accessToken,
      });
      return response.data.accounts;
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
  };
}
