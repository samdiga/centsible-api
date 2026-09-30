import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { AccountService } from "../accounts/index.js";
import type { PlaidService } from "../plaid/index.js";
import { getDb } from "../../platform/database/client.js";
import { NotFoundError } from "../../platform/errors/app-error.js";
import { logger as runtimeLogger } from "../../platform/logging/logger.js";
import type { AppEnv } from "../../platform/http/hono-env.js";
import {
  hasLocalMutationHeader,
  isLocalHostHeader,
  isLoopbackAddress,
  LOCAL_MUTATION_HEADER,
} from "./local-accounts.guard.js";
import { localAccountsPage } from "./local-accounts.page.js";

export type LocalAccountsConfig = Readonly<{
  email: string;
  port: number;
}>;

export type LocalAccountsDependencies = Readonly<{
  config: LocalAccountsConfig;
  plaid: Pick<
    PlaidService,
    | "listItems"
    | "createLinkToken"
    | "exchangePublicToken"
    | "createUpdateLinkToken"
    | "unlinkItem"
  >;
  accounts: Pick<AccountService, "listAccountSummaries">;
  /** The configured user's id, or null when no user has that email. */
  resolveUserId?: (email: string) => Promise<string | null>;
  /** The TCP peer's address; injectable because tests have no socket. */
  remoteAddress?: (c: Context<AppEnv>) => string | undefined;
  logger?: Pick<typeof runtimeLogger, "info" | "warn">;
}>;

const ExchangeBodySchema = z.object({
  publicToken: z.string().min(1),
  institution: z.object({ id: z.string().min(1), name: z.string().min(1) }),
});

async function userIdForEmail(email: string): Promise<string | null> {
  const rows = await getDb().execute<{ id: string }>(
    sql`select id from users where lower(email) = lower(${email}) limit 1`,
  );
  return rows[0]?.id ?? null;
}

function socketAddress(c: Context<AppEnv>): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    // No Node socket (e.g. an in-process request): not provably local.
    return undefined;
  }
}

/**
 * A localhost-only page for linking banks from the Mac mini's browser, for
 * banks whose iOS flow hands off to their own app. Registered only when
 * LOCAL_ACCOUNTS_PAGE is on; every route reuses the app's own Plaid and
 * account services as the one configured user, so linking, syncing and
 * audit behave exactly as they do from the app.
 */
export function registerLocalAccountsRoutes(
  app: Hono<AppEnv>,
  dependencies: LocalAccountsDependencies,
): void {
  const { config, plaid, accounts } = dependencies;
  const log = dependencies.logger ?? runtimeLogger;
  const remoteAddress = dependencies.remoteAddress ?? socketAddress;
  const resolve = dependencies.resolveUserId ?? userIdForEmail;

  // Resolved once; a missing user is logged at startup, not per request.
  let userId: Promise<string | null> | undefined;
  const configuredUser = () => {
    userId ??= resolve(config.email).then(
      (id) => {
        if (!id)
          log.warn(
            {},
            "local accounts page is on but LOCAL_ACCOUNTS_USER_EMAIL matches no user; its routes answer 404",
          );
        return id;
      },
      (error: unknown) => {
        userId = undefined; // try again on the next request
        throw error;
      },
    );
    return userId;
  };
  void configuredUser().catch(() => undefined);

  // Every check answers 404, so nothing reveals the page exists.
  const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (
      !isLoopbackAddress(remoteAddress(c)) ||
      !isLocalHostHeader(c.req.header("host"), config.port)
    )
      throw new NotFoundError("route");
    if (
      c.req.method !== "GET" &&
      !hasLocalMutationHeader(c.req.header(LOCAL_MUTATION_HEADER))
    )
      throw new NotFoundError("route");
    const id = await configuredUser();
    if (!id) throw new NotFoundError("route");
    c.set("userId", id);
    await next();
  };
  app.use("/local/*", guard);

  app.get("/local/accounts", (c) => {
    // Plaid's OAuth pop-up needs to talk back to this window.
    c.header("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    c.header("Cache-Control", "no-store");
    return c.html(localAccountsPage(config.email));
  });

  app.get("/local/plaid/items", async (c) => {
    const id = c.get("userId");
    const [items, summaries] = await Promise.all([
      plaid.listItems(id),
      accounts.listAccountSummaries(id),
    ]);
    return c.json({
      items: items.map((item) => ({
        ...item,
        accounts: summaries
          .filter((account) => account.plaidItem?.id === item.id)
          .map(({ id: accountId, name, mask, type }) => ({
            id: accountId,
            name,
            mask,
            type,
          })),
      })),
    });
  });

  app.post("/local/plaid/link-token", async (c) =>
    c.json(await plaid.createLinkToken(c.get("userId"))),
  );

  app.post("/local/plaid/exchange", async (c) => {
    const body = ExchangeBodySchema.parse(await c.req.json());
    const result = await plaid.exchangePublicToken(c.get("userId"), body);
    log.info({ itemId: result.itemId }, "local accounts page linked a bank");
    return c.json(result);
  });

  app.post("/local/plaid/items/:itemId/update-link-token", async (c) =>
    c.json(
      await plaid.createUpdateLinkToken(c.get("userId"), c.req.param("itemId")),
    ),
  );

  app.delete("/local/plaid/items/:itemId", async (c) => {
    await plaid.unlinkItem(c.get("userId"), c.req.param("itemId"));
    return c.json({ ok: true });
  });
}
