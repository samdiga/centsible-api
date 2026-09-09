import { expect, it, vi } from "vitest";
import { createPlaidService } from "../plaid.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const item = {
  id: ITEM_ID,
  userId: USER_ID,
  plaidItemId: "plaid-item",
  institutionId: "ins_1",
  institutionName: "Test Bank",
  accessTokenEncrypted: "encrypted",
  accessTokenNonce: "nonce",
  cursor: null,
  status: "active" as const,
  errorCode: null,
  errorMessage: null,
  availableProducts: [],
  billedProducts: [],
  consentedProducts: [],
  lastSyncAt: null,
  lastWebhookAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

function dependencies() {
  const repository = {
    listByUser: vi.fn(async () => [item]),
    findById: vi.fn(async () => item),
    findByPlaidItemId: vi.fn(async () => null),
    create: vi.fn(async () => item),
    softDelete: vi.fn(async () => true),
    isFeatureEnabled: vi.fn(async () => true),
    ensureUserSchedule: vi.fn(async () => undefined),
  };
  const client = {
    createLinkToken: vi.fn(async () => ({
      linkToken: "link-token",
      expiration: "2026-09-10T00:00:00.000Z",
    })),
    exchangePublicToken: vi.fn(async () => ({
      accessToken: "access-secret",
      plaidItemId: "plaid-item",
    })),
    createUpdateLinkToken: vi.fn(async () => ({
      linkToken: "update-token",
      expiration: "2026-09-10T00:00:00.000Z",
    })),
    getBalances: vi.fn(async () => []),
    removeItem: vi.fn(async () => undefined),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const tx = {};
  const withUserMutation = vi.fn(
    async (_userId: string, callback: (value: object) => Promise<unknown>) =>
      callback(tx),
  );
  const startPipeline = vi.fn(async () => ({
    runId: "33333333-3333-4333-8333-333333333333",
    deduped: false,
  }));
  return {
    repository,
    client,
    audit,
    withUserMutation,
    startPipeline,
    cipher: {
      encrypt: vi.fn(() => ({ encrypted: "encrypted", nonce: "nonce" })),
      decrypt: vi.fn(() => "access-secret"),
    },
    consume: vi.fn(),
    logger: { warn: vi.fn() },
    accounts: {
      findById: vi.fn(),
      updateBalances: vi.fn(),
    },
  };
}

it("maps linked items without exposing encrypted tokens", async () => {
  const deps = dependencies();
  const service = createPlaidService(deps as never);

  await expect(service.listItems(USER_ID)).resolves.toEqual([
    {
      id: ITEM_ID,
      institutionId: "ins_1",
      institutionName: "Test Bank",
      status: "active",
      errorCode: null,
      errorMessage: null,
      initialSyncComplete: false,
    },
  ]);
});

it("persists an exchanged token, audits once, bootstraps sync, and starts a run", async () => {
  const deps = dependencies();
  const service = createPlaidService(deps as never);

  await expect(
    service.exchangePublicToken(USER_ID, {
      publicToken: "public-token",
      institution: { id: "ins_1", name: "Test Bank" },
    }),
  ).resolves.toEqual({ itemId: ITEM_ID });

  expect(deps.repository.create).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: USER_ID,
      plaidItemId: "plaid-item",
      accessToken: { encrypted: "encrypted", nonce: "nonce" },
    }),
    expect.anything(),
  );
  expect(deps.withUserMutation).toHaveBeenCalledOnce();
  expect(deps.audit.record).toHaveBeenCalledOnce();
  expect(deps.repository.ensureUserSchedule).toHaveBeenCalledOnce();
  expect(deps.startPipeline).toHaveBeenCalledWith({
    userId: USER_ID,
    trigger: "manual",
  });
});

it("disconnects locally when Plaid item removal fails", async () => {
  const deps = dependencies();
  deps.client.removeItem.mockRejectedValueOnce(new Error("provider secret"));
  const service = createPlaidService(deps as never);

  await expect(service.unlinkItem(USER_ID, ITEM_ID)).resolves.toBeUndefined();
  expect(deps.repository.softDelete).toHaveBeenCalledWith(
    ITEM_ID,
    USER_ID,
    expect.anything(),
  );
  expect(deps.audit.record).toHaveBeenCalledOnce();
  expect(deps.logger.warn).toHaveBeenCalledOnce();
});

it("revokes every active item before destructive user-data operations", async () => {
  const deps = dependencies();
  const service = createPlaidService(deps as never);

  await expect(service.revokeAllItems(USER_ID)).resolves.toBeUndefined();
  expect(deps.client.removeItem).toHaveBeenCalledWith("access-secret");
});
