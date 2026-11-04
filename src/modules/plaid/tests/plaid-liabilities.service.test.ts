import { expect, it, vi } from "vitest";
import { createPlaidLiabilitiesService } from "../plaid-liabilities.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";

const plaidError = (code: string) =>
  Object.assign(new Error(code), {
    response: { data: { error_code: code } },
  });

function setup(liabilitiesStatus: string | null = null) {
  const repository = {
    findById: vi.fn(async () => ({
      id: ITEM_ID,
      accessTokenEncrypted: "encrypted",
      accessTokenNonce: "nonce",
      liabilitiesStatus,
    })),
    isFeatureEnabled: vi.fn(async () => true),
    hasLiabilityAccounts: vi.fn(async () => true),
    setLiabilitiesStatus: vi.fn(async () => undefined),
    recordLiabilitiesFailure: vi.fn(async () => undefined),
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
    getConsentedProducts: vi.fn(
      async (): Promise<string[]> => ["transactions", "liabilities"],
    ),
  };
  const audit = { record: vi.fn(async () => undefined) };
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
    audit,
  } as never);
  return { service, repository, client, updateLiabilities, audit };
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
    expect(repository.recordLiabilitiesFailure).toHaveBeenCalledWith(
      ITEM_ID,
      USER_ID,
      { clearConsent: false },
      expect.anything(),
    );
  },
);

it("audits what a Plaid support ticket needs for every failed fetch", async () => {
  const { service, client, audit } = setup();
  client.getLiabilities.mockRejectedValueOnce(
    Object.assign(new Error("boom"), {
      response: {
        data: {
          request_id: "req-123",
          error_type: "API_ERROR",
          error_code: "INTERNAL_SERVER_ERROR",
          error_message: "an unexpected error occurred",
        },
      },
    }),
  );

  await service.syncItemLiabilities(USER_ID, ITEM_ID);
  expect(audit.record).toHaveBeenCalledWith(
    {
      userId: USER_ID,
      entityType: "plaid_item",
      entityId: ITEM_ID,
      action: "sync",
      source: "plaid.liabilities.failed",
      after: {
        plaid: {
          requestId: "req-123",
          errorType: "API_ERROR",
          errorCode: "INTERNAL_SERVER_ERROR",
          errorMessage: "an unexpected error occurred",
        },
      },
    },
    expect.anything(),
  );
});

it("a fetch that records a status doesn't count as a failure", async () => {
  const { service, repository, client } = setup("consent_required");
  client.getLiabilities.mockRejectedValueOnce(
    plaidError("ADDITIONAL_CONSENT_REQUIRED"),
  );

  await service.syncItemLiabilities(USER_ID, ITEM_ID);
  expect(repository.recordLiabilitiesFailure).not.toHaveBeenCalled();
  expect(client.getConsentedProducts).not.toHaveBeenCalled();
});

it("a re-approve it clears is noted in the audit", async () => {
  const { service, client, audit } = setup("consent_required");
  client.getLiabilities.mockRejectedValueOnce(
    plaidError("INTERNAL_SERVER_ERROR"),
  );

  await service.syncItemLiabilities(USER_ID, ITEM_ID);
  expect(audit.record).toHaveBeenCalledWith(
    expect.objectContaining({
      after: expect.objectContaining({ clearedConsent: true }),
    }),
    expect.anything(),
  );
});

it.each<[string, () => Promise<string[]>, boolean]>([
  ["consented", async () => ["transactions", "liabilities"], true],
  ["not consented", async () => ["transactions"], false],
  [
    "unknown (/item/get failed)",
    async () => {
      throw plaidError("INTERNAL_SERVER_ERROR");
    },
    false,
  ],
])(
  "after re-approval, Liabilities %s at Plaid: clears re-approve = %s",
  async (_label, consented, clearConsent) => {
    const { service, repository, client } = setup("consent_required");
    client.getLiabilities.mockRejectedValueOnce(
      plaidError("INTERNAL_SERVER_ERROR"),
    );
    client.getConsentedProducts.mockImplementationOnce(consented);

    await expect(
      service.syncItemLiabilities(USER_ID, ITEM_ID),
    ).resolves.toEqual({
      accountsUpdated: 0,
      unavailableReason: "INTERNAL_SERVER_ERROR",
    });
    expect(repository.recordLiabilitiesFailure).toHaveBeenCalledWith(
      ITEM_ID,
      USER_ID,
      { clearConsent },
      expect.anything(),
    );
  },
);

it("a token that won't decrypt counts as a failed fetch, not a crash", async () => {
  const { repository, client } = setup("consent_required");
  const failing = createPlaidLiabilitiesService({
    repository,
    client,
    cipher: {
      decrypt: vi.fn(() => {
        throw new Error("bad nonce");
      }),
    },
    accounts: { updateLiabilities: vi.fn() },
    withUserMutation: async (
      _userId: string,
      callback: (tx: never) => Promise<unknown>,
    ) => callback({} as never),
    audit: { record: vi.fn(async () => undefined) },
  } as never);

  await expect(failing.syncItemLiabilities(USER_ID, ITEM_ID)).resolves.toEqual({
    accountsUpdated: 0,
    unavailableReason: "UNKNOWN",
  });
  expect(client.getConsentedProducts).not.toHaveBeenCalled();
  expect(repository.recordLiabilitiesFailure).toHaveBeenCalledWith(
    ITEM_ID,
    USER_ID,
    { clearConsent: false },
    expect.anything(),
  );
});

it("only checks consent when re-approve is what's recorded", async () => {
  const { service, client } = setup("available");
  client.getLiabilities.mockRejectedValueOnce(
    plaidError("INTERNAL_SERVER_ERROR"),
  );

  await service.syncItemLiabilities(USER_ID, ITEM_ID);
  expect(client.getConsentedProducts).not.toHaveBeenCalled();
});

it("does nothing while the Liabilities flag is off", async () => {
  const { service, repository, client } = setup();
  repository.isFeatureEnabled.mockResolvedValueOnce(false);

  await expect(service.syncItemLiabilities(USER_ID, ITEM_ID)).resolves.toEqual({
    accountsUpdated: 0,
    unavailableReason: "FLAG_DISABLED",
  });
  expect(client.getLiabilities).not.toHaveBeenCalled();
});
