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
export const ExchangePublicTokenBodySchema = z.object({
  publicToken: z.string().min(1),
  institution: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  }),
});
export type ExchangePublicTokenBody = z.infer<
  typeof ExchangePublicTokenBodySchema
>;
export const LinkTokenResponseSchema = z.object({
  linkToken: z.string().min(1),
  expiration: z.string().datetime({ offset: true }),
});
export type LinkTokenResponse = z.infer<typeof LinkTokenResponseSchema>;
export const ExchangePublicTokenResponseSchema = z.object({
  itemId: PlaidItemIdSchema,
});
export const PlaidItemSummarySchema = z.object({
  id: PlaidItemIdSchema,
  institutionId: z.string().nullable(),
  institutionName: z.string().nullable(),
  status: PlaidItemStatusSchema,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  initialSyncComplete: z.boolean(),
});
export type PlaidItemSummary = z.infer<typeof PlaidItemSummarySchema>;
export const PlaidItemsResponseSchema = z.object({
  items: z.array(PlaidItemSummarySchema),
});
export const RefreshItemBalancesResponseSchema = z.object({
  accounts: z.array(AccountBalanceSchema),
});
export const DeletePlaidItemResponseSchema = z.object({ ok: z.literal(true) });
export const PlaidErrorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  requestId: z.string(),
});
