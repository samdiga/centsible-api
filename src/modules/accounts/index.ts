export { registerAccountsRoutes } from "./accounts.routes.js";
export { createAccountService } from "./accounts.service.js";
export type {
  AccountService,
  AccountRefresher,
  AccountRefreshPort,
  RemoveAccountResult,
} from "./accounts.service.js";
export type { ActiveItemUnlinker } from "./accounts-item-unlinker.js";
import type { DbTransaction } from "../../platform/database/types.js";
import type { PlaidAccountData } from "./accounts.schemas.js";
export type { PlaidAccountData } from "./accounts.schemas.js";

export type PlaidAccountRecord = Readonly<{
  id: string;
  userId: string;
  plaidItemId: string | null;
  plaidAccountId: string | null;
}>;

/** Narrow Plan 3 dependency for writing Plaid account payloads. */
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
