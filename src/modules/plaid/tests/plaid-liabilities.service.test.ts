import { expect, it, vi } from "vitest";
import { createPlaidLiabilitiesService } from "../plaid-liabilities.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";

it("persists supported liability fields as cents through the accounts port", async () => {
  const updateLiabilities = vi.fn(async () => true);
  const service = createPlaidLiabilitiesService({
    repository: {
      findById: vi.fn(async () => ({
        id: ITEM_ID,
        accessTokenEncrypted: "encrypted",
        accessTokenNonce: "nonce",
      })),
      isFeatureEnabled: vi.fn(async () => true),
    },
    client: {
      getLiabilities: vi.fn(async () => ({
        credit: [
          {
            account_id: "plaid-account",
            aprs: [{ apr_type: "purchase_apr", apr_percentage: 19.5 }],
            minimum_payment_amount: 12.34,
            next_payment_due_date: "2026-10-01",
            last_statement_balance: 101.01,
            last_statement_issue_date: "2026-09-01",
          },
        ],
        student: [],
        mortgage: [],
      })),
    },
    cipher: { decrypt: vi.fn(() => "access-token") },
    accounts: { updateLiabilities },
    withUserMutation: async (
      _userId: string,
      callback: (tx: never) => Promise<unknown>,
    ) => callback({} as never),
    audit: { record: vi.fn(async () => undefined) },
  } as never);

  await expect(service.syncItemLiabilities(USER_ID, ITEM_ID)).resolves.toEqual({
    accountsUpdated: 1,
    unavailableReason: null,
  });
  expect(updateLiabilities).toHaveBeenCalledWith(
    USER_ID,
    "plaid-account",
    expect.objectContaining({
      apr: 19.5,
      minimumPayment: 1234n,
      statementBalance: 10101n,
    }),
    expect.anything(),
  );
});
