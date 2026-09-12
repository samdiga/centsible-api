import { describe, expect, it } from "vitest";
import {
  parseBaseUrl,
  runSmoke,
  runSmokeCli,
  type SmokeFetch,
} from "../smoke-api.js";

const TOKEN = "secret-bearer-token";
const EXPECTED_AUTHENTICATED_ROUTES = [
  "/accounts",
  "/dashboard/summary",
  "/transactions?limit=1",
  "/bills",
  "/budgets/active",
  "/forecast?horizonDays=30",
  "/plaid/items",
] as const;

function response(status = 200, body?: unknown, requestId = "req-safe-1") {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
    },
  });
}

function recordingFetch(
  responder: (url: URL, init: RequestInit) => Response = () => response(),
) {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const fetchImpl: SmokeFetch = async (input, init) => {
    const request = { url: new URL(String(input)), init: init ?? {} };
    requests.push(request);
    return responder(request.url, request.init);
  };
  return { fetchImpl, requests };
}

describe("runSmoke", () => {
  it("always checks health without authorization and skips private routes without exposing environment data", async () => {
    const { fetchImpl, requests } = recordingFetch();
    const lines: string[] = [];

    const summary = await runSmoke({
      baseUrl: "http://127.0.0.1:4001/",
      fetchImpl,
      writeLine: (line) => lines.push(line),
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.href).toBe("http://127.0.0.1:4001/health");
    expect(requests[0]?.init.headers).toBeUndefined();
    expect(lines).toEqual([
      "PASS GET /health status=200 requestId=req-safe-1",
      ...EXPECTED_AUTHENTICATED_ROUTES.map((route) => `SKIP GET ${route}`),
      "SUMMARY pass=1 skip=7 fail=0",
    ]);
    expect(summary).toEqual({ passed: 1, skipped: 7, failed: 0 });
  });

  it("checks every authenticated route with the exact query strings and bearer header", async () => {
    const { fetchImpl, requests } = recordingFetch();

    await runSmoke({
      baseUrl: "https://api.example.test/root/",
      token: TOKEN,
      fetchImpl,
      writeLine: () => undefined,
    });

    expect(requests.map(({ url }) => `${url.pathname}${url.search}`)).toEqual([
      "/root/health",
      ...EXPECTED_AUTHENTICATED_ROUTES.map((route) => `/root${route}`),
    ]);
    expect(requests[0]?.init.headers).toBeUndefined();
    for (const request of requests.slice(1)) {
      expect(request.init.headers).toEqual({
        Authorization: `Bearer ${TOKEN}`,
      });
      expect(request.init.redirect).toBe("error");
      expect(request.init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("accepts only the documented status and safe-code alternatives", async () => {
    const accepted = recordingFetch((url) => {
      if (url.pathname.endsWith("/budgets/active"))
        return response(404, { error: { code: "NOT_FOUND" } });
      if (url.pathname.endsWith("/forecast"))
        return response(403, { error: { code: "FEATURE_DISABLED" } });
      return response();
    });

    await expect(
      runSmoke({
        baseUrl: "http://127.0.0.1:4001",
        token: TOKEN,
        fetchImpl: accepted.fetchImpl,
        writeLine: () => undefined,
      }),
    ).resolves.toEqual({ passed: 8, skipped: 0, failed: 0 });

    for (const [path, status, code] of [
      ["/accounts", 404, "NOT_FOUND"],
      ["/budgets/active", 404, "WRONG_CODE"],
      ["/forecast", 403, "WRONG_CODE"],
    ] as const) {
      const rejected = recordingFetch((url) =>
        url.pathname.endsWith(path)
          ? response(status, { error: { code } })
          : response(),
      );
      await expect(
        runSmoke({
          baseUrl: "http://127.0.0.1:4001",
          token: TOKEN,
          fetchImpl: rejected.fetchImpl,
          writeLine: () => undefined,
        }),
      ).rejects.toThrow(`GET ${path}`);
    }
  });

  it("reports only safe failure metadata and stops on the first failed required check", async () => {
    const sensitiveBody = {
      error: {
        code: "UPSTREAM_FAILURE",
        message: "account Checking has $123.45 at postgres://user:pass@host/db",
      },
      requestId: "body-request-id",
      transaction: "Coffee Shop",
    };
    const { fetchImpl, requests } = recordingFetch((url) =>
      url.pathname.endsWith("/accounts")
        ? response(503, sensitiveBody, "header-request-id")
        : response(),
    );
    const lines: string[] = [];

    await expect(
      runSmoke({
        baseUrl: "http://127.0.0.1:4001",
        token: TOKEN,
        fetchImpl,
        writeLine: (line) => lines.push(line),
      }),
    ).rejects.toThrow(
      "GET /accounts status=503 code=UPSTREAM_FAILURE requestId=header-request-id",
    );
    expect(requests).toHaveLength(2);
    const output = lines.join("\n");
    expect(output).toContain(
      "FAIL GET /accounts status=503 code=UPSTREAM_FAILURE requestId=header-request-id",
    );
    for (const secret of [
      TOKEN,
      "Authorization",
      "Checking",
      "$123.45",
      "postgres://",
      "Coffee Shop",
      "account Checking has",
    ])
      expect(output).not.toContain(secret);
  });

  it("uses a validated body request ID only when the header is unavailable", async () => {
    const { fetchImpl } = recordingFetch((url) => {
      if (!url.pathname.endsWith("/accounts")) return response();
      const result = response(500, {
        error: { code: "SERVER_ERROR" },
        requestId: "body_req-2",
      });
      result.headers.delete("x-request-id");
      return result;
    });

    await expect(
      runSmoke({
        baseUrl: "http://127.0.0.1:4001",
        token: TOKEN,
        fetchImpl,
        writeLine: () => undefined,
      }),
    ).rejects.toThrow(
      "GET /accounts status=500 code=SERVER_ERROR requestId=body_req-2",
    );
  });

  it("applies a finite timeout and rejects credential-bearing, queried, fragmented, or invalid base URLs", async () => {
    for (const input of [
      "",
      "ftp://127.0.0.1",
      "http://user:pass@127.0.0.1:4001",
      "http://127.0.0.1:4001?token=value",
      "http://127.0.0.1:4001/#fragment",
      "not a url",
    ])
      expect(() => parseBaseUrl(input)).toThrow("Invalid --base-url");

    expect(parseBaseUrl("http://127.0.0.1:4001/path///").href).toBe(
      "http://127.0.0.1:4001/path/",
    );

    const { fetchImpl, requests } = recordingFetch();
    await runSmoke({
      baseUrl: "http://127.0.0.1:4001",
      fetchImpl,
      timeoutMs: 25,
      writeLine: () => undefined,
    });
    expect(requests[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("runSmokeCli", () => {
  it("returns zero only after all applicable checks pass", async () => {
    const passing = recordingFetch();
    await expect(
      runSmokeCli(
        ["--base-url", "http://127.0.0.1:4001"],
        {},
        {
          fetchImpl: passing.fetchImpl,
          writeLine: () => undefined,
        },
      ),
    ).resolves.toBe(0);

    const failing = recordingFetch(() => response(500));
    await expect(
      runSmokeCli(
        ["--base-url", "http://127.0.0.1:4001"],
        {},
        {
          fetchImpl: failing.fetchImpl,
          writeLine: () => undefined,
        },
      ),
    ).resolves.toBe(1);
  });

  it("fails safely when --base-url is missing or malformed", async () => {
    const lines: string[] = [];
    await expect(
      runSmokeCli(
        [],
        { CENTSIBLE_SMOKE_TOKEN: TOKEN },
        {
          fetchImpl: recordingFetch().fetchImpl,
          writeLine: (line) => lines.push(line),
        },
      ),
    ).resolves.toBe(1);
    expect(lines.join("\n")).toBe("FAIL Invalid --base-url");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});
