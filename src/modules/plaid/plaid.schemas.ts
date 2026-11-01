import { z } from "zod";
import { AccountBalanceSchema } from "../accounts/accounts.schemas.js";

export const PlaidItemIdSchema = z.string().uuid();
export const PlaidItemStatusSchema = z.enum([
  "active",
  "login_required",
  "error",
  "pending_expiration",
  "disconnected",
]);
export const PlaidItemHealthSchema = z.enum([
  "ok",
  "stale",
  "needs_relink",
  "expiring",
  "error",
]);
export type PlaidItemHealth = z.infer<typeof PlaidItemHealthSchema>;
/** An account as Link's onSuccess metadata describes it. */
export const LinkedAccountMetadataSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  mask: z.string().nullish(),
  type: z.string().min(1),
  /** Null when the app couldn't name it; matching then uses mask + type. */
  subtype: z.string().nullish(),
});
export const ExchangePublicTokenBodySchema = z.object({
  publicToken: z.string().min(1),
  institution: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  }),
  /** Lets the server spot a bank the user already has before exchanging.
   * Optional: app builds before T-170 don't send it. */
  accounts: z.array(LinkedAccountMetadataSchema).max(100).optional(),
});
export type ExchangePublicTokenBody = z.infer<
  typeof ExchangePublicTokenBodySchema
>;
export const LinkTokenResponseSchema = z.object({
  linkToken: z.string().min(1),
  expiration: z.string().datetime({ offset: true }),
});
export type LinkTokenResponse = z.infer<typeof LinkTokenResponseSchema>;
export const RestoredAccountSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  mask: z.string().nullable(),
});
export const ExchangePublicTokenResponseSchema = z.object({
  itemId: PlaidItemIdSchema,
  /** Removed accounts this link took over instead of duplicating. */
  restoredAccounts: z.array(RestoredAccountSchema),
});
export type RestoredAccount = z.infer<typeof RestoredAccountSchema>;
/** `details` of a PLAID_DUPLICATE_ITEM conflict: the connection to fix instead. */
export const DuplicateItemDetailsSchema = z.object({
  itemId: PlaidItemIdSchema,
  institutionName: z.string().nullable(),
  accounts: z.array(RestoredAccountSchema).min(1),
});
export type DuplicateItemDetails = z.infer<typeof DuplicateItemDetailsSchema>;
export const PlaidItemSummarySchema = z.object({
  id: PlaidItemIdSchema,
  institutionId: z.string().nullable(),
  institutionName: z.string().nullable(),
  status: PlaidItemStatusSchema,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  initialSyncComplete: z.boolean(),
  lastSuccessfulSyncAt: z.string().datetime({ offset: true }).nullable(),
  health: PlaidItemHealthSchema,
  /**
   * The bank needs the user to re-approve sharing (Plaid update mode)
   * before card and loan statements can be fetched.
   */
  liabilitiesConsentRequired: z.boolean(),
  /**
   * When the bank last refreshed this connection at Plaid. Unlike
   * `lastSuccessfulSyncAt` (when we last asked Plaid), this stops moving
   * when the bank does. Null until known.
   */
  bankLastUpdatedAt: z.string().datetime({ offset: true }).nullable(),
  /**
   * The connection looks fine but the bank hasn't refreshed for longer than
   * the stale threshold. Never set alongside an error state, which already
   * says more.
   */
  bankNotRefreshing: z.boolean(),
});
export type PlaidItemSummary = z.infer<typeof PlaidItemSummarySchema>;
export const PlaidItemsResponseSchema = z.object({
  items: z.array(PlaidItemSummarySchema),
});
export const RefreshCachedItemAccountsResponseSchema = z.object({
  accounts: z.array(AccountBalanceSchema),
});
export const DeletePlaidItemResponseSchema = z.object({ ok: z.literal(true) });
export const PlaidErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
