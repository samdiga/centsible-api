import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { localAccountsPage } from "../local-accounts.page.js";

type PageElement = {
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  className: string;
  onclick?: () => Promise<void>;
  append: (...children: PageElement[]) => void;
  replaceChildren: (...children: PageElement[]) => void;
};

type PlaidConfig = {
  onEvent: (event: string, metadata: Record<string, unknown>) => void;
  onExit: (
    error: Record<string, unknown>,
    metadata: Record<string, unknown>,
  ) => void;
};

function element(): PageElement {
  return {
    textContent: "",
    hidden: false,
    disabled: false,
    className: "",
    append: () => undefined,
    replaceChildren: () => undefined,
  };
}

describe("local accounts Link diagnostics", () => {
  it("shows the API request ID when token creation fails without Plaid metadata", async () => {
    const html = localAccountsPage("sam@example.test", "production");
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    const elements = new Map(ids.map((id) => [id, element()]));
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();

    runInNewContext(script!, {
      document: {
        getElementById: (id: string) => elements.get(id) ?? null,
        querySelectorAll: () => [...elements.values()],
        createElement: element,
      },
      fetch: async (path: string) =>
        path === "/local/plaid/items"
          ? { ok: true, json: async () => ({ items: [] }) }
          : {
              ok: false,
              status: 500,
              json: async () => ({
                error: { code: "INTERNAL", message: "Something went wrong." },
                requestId: "apiReq123",
              }),
            },
      Plaid: { create: vi.fn() },
    });

    await elements.get("add")?.onclick?.();
    const report = elements.get("debug-info")?.textContent;
    expect(report).toContain("Link session ID: Not started");
    expect(report).toContain("API request ID: apiReq123");
    expect(report).toContain("Plaid request ID: Not returned");
    expect(report).toContain("HTTP status: 500");
    expect(report).toContain("Last event: LINK_TOKEN_ERROR");
  });

  it("shows a copyable support packet when Link token creation fails before Plaid opens", async () => {
    const html = localAccountsPage("sam@example.test", "production");
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    const elements = new Map(ids.map((id) => [id, element()]));
    const copied: string[] = [];
    const createPlaid = vi.fn();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();

    runInNewContext(script!, {
      document: {
        getElementById: (id: string) => elements.get(id) ?? null,
        querySelectorAll: () => [...elements.values()],
        createElement: element,
      },
      navigator: {
        clipboard: {
          writeText: async (text: string) => {
            copied.push(text);
          },
        },
      },
      fetch: async (path: string) =>
        path === "/local/plaid/items"
          ? { ok: true, json: async () => ({ items: [] }) }
          : {
              ok: false,
              status: 502,
              json: async () => ({
                error: {
                  code: "PLAID_LINK_TOKEN_FAILED",
                  message: "Plaid could not start bank linking.",
                  details: {
                    plaidErrorCode: "INVALID_PRODUCT",
                    plaidRequestId: "plaidReq123",
                    plaidStatus: 400,
                    accessToken: "access-secret",
                  },
                },
                requestId: "localReq456",
              }),
            },
      Plaid: { create: createPlaid },
    });

    await elements.get("add")?.onclick?.();
    const report = elements.get("debug-info")?.textContent;
    expect(elements.get("diagnostics")?.hidden).toBe(false);
    expect(report).toContain("Environment: production");
    expect(report).toContain("Link session ID: Not started");
    expect(report).toContain("Plaid request ID: plaidReq123");
    expect(report).toContain("API request ID: localReq456");
    expect(report).toContain("Error code: INVALID_PRODUCT");
    expect(report).toContain("Plaid HTTP status: 400");
    expect(report).toContain("HTTP status: 502");
    expect(report).not.toContain("access-secret");
    expect(createPlaid).not.toHaveBeenCalled();

    await elements.get("copy-debug")?.onclick?.();
    expect(copied).toEqual([report]);
  });

  it("shows and copies Plaid support fields without tokens or account details", async () => {
    const html = localAccountsPage("sam@example.test", "production");
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    const elements = new Map(ids.map((id) => [id, element()]));
    const copied: string[] = [];
    let plaidConfig: PlaidConfig | undefined;

    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    runInNewContext(script!, {
      document: {
        getElementById: (id: string) => elements.get(id) ?? null,
        querySelectorAll: () => [...elements.values()],
        createElement: element,
      },
      navigator: {
        clipboard: {
          writeText: async (text: string) => {
            copied.push(text);
          },
        },
      },
      fetch: async (path: string) => ({
        ok: true,
        json: async () =>
          path === "/local/plaid/items"
            ? { items: [] }
            : { linkToken: "link-production-secret" },
      }),
      Plaid: {
        create: (config: PlaidConfig) => {
          plaidConfig = config;
          return { open: () => undefined };
        },
      },
    });

    const add = elements.get("add");
    expect(add?.onclick).toBeDefined();
    const action = add!.onclick!();
    await vi.waitFor(() => expect(plaidConfig).toBeDefined());
    expect(plaidConfig?.onEvent).toBeTypeOf("function");

    plaidConfig!.onEvent("OPEN", {
      link_session_id: "link-session-123",
      request_id: "plaid-request-456",
      timestamp: "2026-10-01T13:00:00.000Z",
      institution_name: "Chase",
      public_token: "public-secret",
      account_number: "987654321",
    });
    expect(elements.get("debug-info")?.textContent).toContain(
      "Link session ID: link-session-123",
    );
    plaidConfig!.onEvent("ERROR", {
      link_session_id: "link-session-123",
      request_id: "plaid-request-789",
      timestamp: "2026-10-01T13:00:08.000Z",
      institution_name: "Chase",
      error_code: "INTERNAL_SERVER_ERROR",
      error_message: "private error detail",
    });
    plaidConfig!.onEvent("SELECT_INSTITUTION", {
      link_session_id: "link-session-123",
      request_id: "plaid-request-older",
      timestamp: "2026-10-01T13:00:04.000Z",
      institution_name: "Chase",
    });
    expect(elements.get("debug-info")?.textContent).toContain(
      "Last event: ERROR",
    );
    expect(elements.get("debug-info")?.textContent).toContain(
      "Plaid request ID: plaid-request-789",
    );
    plaidConfig!.onExit(
      {
        error_code: "INTERNAL_SERVER_ERROR",
        error_message: "private exit detail",
      },
      {
        link_session_id: "link-session-123",
        request_id: "plaid-request-789",
        institution: { name: "Chase" },
        status: "requires_oauth",
      },
    );
    await action;

    const report = elements.get("debug-info")?.textContent;
    expect(report).toContain("Environment: production");
    expect(report).toContain("Link session ID: link-session-123");
    expect(report).toContain("Plaid request ID: plaid-request-789");
    expect(report).toContain("Timestamp: 2026-10-01T13:00:08.000Z");
    expect(report).toContain("Institution: Chase");
    expect(report).toContain("Error code: INTERNAL_SERVER_ERROR");
    expect(report).not.toMatch(
      /secret|987654321|private error detail|private exit detail/,
    );

    await elements.get("copy-debug")?.onclick?.();
    expect(copied).toEqual([report]);
  });
});
