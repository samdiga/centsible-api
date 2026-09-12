import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 10_000;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const CHECKS = [
  { route: "/health", authenticated: false, accepts: { 200: undefined } },
  { route: "/accounts", authenticated: true, accepts: { 200: undefined } },
  {
    route: "/dashboard/summary",
    authenticated: true,
    accepts: { 200: undefined },
  },
  {
    route: "/transactions?limit=1",
    authenticated: true,
    accepts: { 200: undefined },
  },
  { route: "/bills", authenticated: true, accepts: { 200: undefined } },
  {
    route: "/budgets/active",
    authenticated: true,
    accepts: { 200: undefined, 404: "NOT_FOUND" },
  },
  {
    route: "/forecast?horizonDays=30",
    authenticated: true,
    accepts: { 200: undefined, 403: "FEATURE_DISABLED" },
  },
  {
    route: "/plaid/items",
    authenticated: true,
    accepts: { 200: undefined },
  },
] as const;

export type SmokeFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type SmokeSummary = Readonly<{
  passed: number;
  skipped: number;
  failed: number;
}>;

type SmokeOptions = Readonly<{
  baseUrl: string;
  token?: string | undefined;
  fetchImpl?: SmokeFetch | undefined;
  timeoutMs?: number | undefined;
  writeLine?: ((line: string) => void) | undefined;
}>;

type CliDependencies = Readonly<{
  fetchImpl?: SmokeFetch | undefined;
  timeoutMs?: number | undefined;
  writeLine?: ((line: string) => void) | undefined;
}>;

class ReportedSmokeError extends Error {}

function safeValue(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

async function safeErrorMetadata(response: Response) {
  let code: string | undefined;
  let bodyRequestId: string | undefined;
  try {
    const body = asRecord(await response.json());
    const error = asRecord(body?.error);
    code = safeValue(error?.code, SAFE_CODE);
    bodyRequestId = safeValue(body?.requestId, SAFE_REQUEST_ID);
  } catch {
    // A malformed or non-JSON error response contributes no output fields.
  }
  return {
    code,
    requestId:
      safeValue(response.headers.get("x-request-id"), SAFE_REQUEST_ID) ??
      bodyRequestId,
  };
}

function joinedUrl(baseUrl: URL, route: string): URL {
  return new URL(route.slice(1), baseUrl);
}

export function parseBaseUrl(input: string | undefined): URL {
  try {
    if (!input) throw new Error();
    const url = new URL(input);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    )
      throw new Error();
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
    return url;
  } catch {
    throw new Error("Invalid --base-url");
  }
}

export async function runSmoke(options: SmokeOptions): Promise<SmokeSummary> {
  const baseUrl = parseBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const writeLine = options.writeLine ?? console.log;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Invalid smoke timeout");

  let passed = 0;
  let skipped = 0;
  let failed = 0;

  for (const check of CHECKS) {
    if (check.authenticated && !options.token) {
      skipped += 1;
      writeLine(`SKIP GET ${check.route}`);
      continue;
    }

    let response: Response;
    try {
      response = await fetchImpl(joinedUrl(baseUrl, check.route), {
        ...(check.authenticated
          ? { headers: { Authorization: `Bearer ${options.token}` } }
          : {}),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      failed += 1;
      const detail = `GET ${check.route} status=NETWORK_ERROR code=UNAVAILABLE requestId=UNAVAILABLE`;
      writeLine(`FAIL ${detail}`);
      writeLine(`SUMMARY pass=${passed} skip=${skipped} fail=${failed}`);
      throw new ReportedSmokeError(detail);
    }

    const metadata = await safeErrorMetadata(response);
    const expectedCode = (check.accepts as Record<number, string | undefined>)[
      response.status
    ];
    const statusAllowed = Object.hasOwn(check.accepts, response.status);
    const accepted =
      statusAllowed &&
      (expectedCode === undefined || expectedCode === metadata.code);
    const requestId = metadata.requestId ?? "UNAVAILABLE";

    if (!accepted) {
      failed += 1;
      const detail = `GET ${check.route} status=${response.status} code=${metadata.code ?? "UNAVAILABLE"} requestId=${requestId}`;
      writeLine(`FAIL ${detail}`);
      writeLine(`SUMMARY pass=${passed} skip=${skipped} fail=${failed}`);
      throw new ReportedSmokeError(detail);
    }

    passed += 1;
    writeLine(
      `PASS GET ${check.route} status=${response.status} requestId=${requestId}`,
    );
  }

  writeLine(`SUMMARY pass=${passed} skip=${skipped} fail=${failed}`);
  return { passed, skipped, failed };
}

function baseUrlArgument(args: readonly string[]): string | undefined {
  if (args.length !== 2 || args[0] !== "--base-url") return undefined;
  return args[1];
}

export async function runSmokeCli(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: CliDependencies = {},
): Promise<number> {
  const writeLine = dependencies.writeLine ?? console.log;
  try {
    const input = baseUrlArgument(args);
    if (!input) throw new Error("Invalid --base-url");
    await runSmoke({
      baseUrl: input,
      token: environment.CENTSIBLE_SMOKE_TOKEN,
      fetchImpl: dependencies.fetchImpl,
      timeoutMs: dependencies.timeoutMs,
      writeLine,
    });
    return 0;
  } catch (error) {
    if (!(error instanceof ReportedSmokeError)) {
      writeLine(
        error instanceof Error && error.message === "Invalid --base-url"
          ? "FAIL Invalid --base-url"
          : "FAIL smoke runner error",
      );
    }
    return 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) {
  process.exitCode = await runSmokeCli(process.argv.slice(2));
}
