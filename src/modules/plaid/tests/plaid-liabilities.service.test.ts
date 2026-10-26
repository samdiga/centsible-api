import { expect, it, vi } from "vitest";
import { createPlaidLiabilitiesService } from "../plaid-liabilities.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";

const plaidError = (code: string) =>
  Object.assign(new Error(code), {
    response: { data: { error_code: code } },
  });

function setup() {
  const repository = {
    findById: vi.fn(async () => ({
      id: ITEM_ID,
      accessTokenEncrypted: "encrypted",
      accessTokenNonce: "nonce",
    })),
    isFeatureEnabled: vi.fn(async () => true),
    hasLiabilityAccounts: vi.fn(async () => true),
    setLiabilitiesStatus: vi.fn(async () => undefined),
  };
  const client = {
    getLiabilities: vi.fn(async (): Promise<unknown> => ({
      credit: [
        {
          account_id: "plaid-account",
          aprs: [{ apr_type: "purchase_apr", apr_percentage: 19.5 }],
          minimum_payment_amount: 12.34,
          next_payment_due_date: "2026-10-01",
          last_statement_balance: 101.01,
          last_statement_issue_date: "2026-09-01",
          last_payment_amount: 87.65,
          last_payment_date: "2026-09-25",
        },
      ],
      student: [],
      mortgage: [],
    })),
  };
  const updateLiabilities = vi.fn(async () => true);
  const service = createPlaidLiabilitiesService({
    repository,
    client,
    cipher: { decrypt: vi.fn(() => "access-token") },
    accounts: { updateLiabilities },
    withUserMutation: async (
      _userId: string,
      callback: (tx: never) => Promise<unknown>,
    ) => callback({} as never),
    audit: { record: vi.fn(async () => undefined) },
  } as never);
  return { service, repository, client, updateLiabilities };
}

it("persists supported liability fields as cents through the accounts port", async () => {
  const { service, updateLiabilities } = setup();

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
      lastPaymentCents: 8765n,
      lastPaymentDate: "2026-09-25",
    }),
    expect.anything(),
  );
});

it("records a successful fetch as available", async () => {
  const { service, repository } = setup();
  await service.syncItemLiabilities(USER_ID, ITEM_ID);
  expect(repository.setLiabilitiesStatus).toHaveBeenCalledWith(
    ITEM_ID,
    USER_ID,
    "available",
    expect.anything(),
  );
});

it("never asks Plaid about a connection without a card or loan", async () => {
  const { service, repository, client } = setup();
  repository.hasLiabilityAccounts.mockResolvedValueOnce(false);

  await expect(service.syncItemLiabilities(USER_ID, ITEM_ID)).resolves.toEqual({
    accountsUpdated: 0,
    unavailableReason: null,
    skipped: true,
  });
  expect(client.getLiabilities).not.toHaveBeenCalled();
  expect(repository.setLiabilitiesStatus).not.toHaveBeenCalled();
});

it.each([
  ["ADDITIONAL_CONSENT_REQUIRED", "consent_required"],
  ["PRODUCTS_NOT_SUPPORTED", "not_supported"],
  ["NO_LIABILITY_ACCOUNTS", "not_supported"],
])("records %s from the bank as %s", async (code, status) => {
  const { service, repository, client } = setup();
  client.getLiabilities.mockRejectedValueOnce(plaidError(code));

  await expect(service.syncItemLiabilities(USER_ID, ITEM_ID)).resolves.toEqual({
    accountsUpdated: 0,
    unavailableReason: code,
  });
  expect(repository.setLiabilitiesStatus).toHaveBeenCalledWith(
    ITEM_ID,
    USER_ID,
    status,
    expect.anything(),
  );
});

it.each(["ITEM_LOGIN_REQUIRED", "PRODUCT_NOT_READY", "RATE_LIMIT_EXCEEDED"])(
  "leaves the recorded status alone on a passing %s",
  async (code) => {
    const { service, repository, client } = setup();
    client.getLiabilities.mockRejectedValueOnce(plaidError(code));

    await expect(
      service.syncItemLiabilities(USER_ID, ITEM_ID),
    ).resolves.toEqual({ accountsUpdated: 0, unavailableReason: code });
    expect(repository.setLiabilitiesStatus).not.toHaveBeenCalled();
  },
);

it("does nothing while the Liabilities flag is off", async () => {
  const { service, repository, client } = setup();
  repository.isFeatureEnabled.mockResolvedValueOnce(false);

  await expect(service.syncItemLiabilities(USER_ID, ITEM_ID)).resolves.toEqual({
    accountsUpdated: 0,
    unavailableReason: "FLAG_DISABLED",
  });
  expect(client.getLiabilities).not.toHaveBeenCalled();
});
