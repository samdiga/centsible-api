import { spawnSync } from "node:child_process";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";

import { createHttpApp } from "../../src/app/create-http-app.js";
import type { AppEnv } from "../../src/platform/http/hono-env.js";
import {
  createOpenApiDocument,
  listOpenApiOperations,
} from "../../src/platform/openapi/document.js";
import sourceManifest from "./source-route-manifest.json" with { type: "json" };

type Operation = { method: string; path: string };
type RouteDefinition = {
  method: string;
  path: string;
  deprecated?: boolean;
  security?: Array<Record<string, string[]>>;
  request?: unknown;
  responses?: unknown;
  tags?: string[];
};

const normalizePath = (path: string) => path.replaceAll(/\{([^}]+)\}/g, ":$1");
const compareOperations = (left: Operation, right: Operation) =>
  left.path.localeCompare(right.path) ||
  left.method.localeCompare(right.method);
const operation = (method: string, path: string): Operation => ({
  method: method.toUpperCase(),
  path: normalizePath(path),
});

function routeDefinitions(app: OpenAPIHono<AppEnv>): RouteDefinition[] {
  return app.openAPIRegistry.definitions
    .filter((definition) => definition.type === "route")
    .map((definition) => definition.route as RouteDefinition);
}

function actualOperations(routes: RouteDefinition[]): Operation[] {
  return routes
    .map(({ method, path }) => operation(method, path))
    .sort(compareOperations);
}

function honoOperations(app: OpenAPIHono<AppEnv>): Operation[] {
  const operations = new Map<string, Operation>();
  for (const route of app.routes) {
    if (route.method === "ALL") continue;
    const current = operation(route.method, route.path);
    operations.set(`${current.method} ${current.path}`, current);
  }
  return [...operations.values()].sort(compareOperations);
}

function documentedOperations(app: OpenAPIHono<AppEnv>): Operation[] {
  return listOpenApiOperations(createOpenApiDocument(app))
    .map(({ method, path }) => operation(method, path))
    .sort(compareOperations);
}

function createParityApp() {
  return createHttpApp({ auth: async (_context, next) => next() });
}

describe("registered route and OpenAPI parity", () => {
  it("registers every expected local canonical operation exactly once and no extras", () => {
    const expected = sourceManifest.canonical
      .filter(({ target }) => target !== "centsy")
      .map(({ method, path }) => operation(method, path))
      .sort(compareOperations);
    const aliases = new Set(
      sourceManifest.aliases.map(({ method, path }) => `${method} ${path}`),
    );
    const actual = actualOperations(routeDefinitions(createParityApp())).filter(
      ({ method, path }) => !aliases.has(`${method} ${path}`),
    );

    expect(expected).toHaveLength(58);
    expect(actual).toEqual(expected);
  });

  it("has no unregistered plain Hono operations outside the approved surface", () => {
    const expected = [
      ...sourceManifest.canonical
        .filter(({ target }) => target !== "centsy")
        .map(({ method, path }) => operation(method, path)),
      ...sourceManifest.aliases.map(({ method, path }) =>
        operation(method, path),
      ),
    ].sort(compareOperations);

    expect(honoOperations(createParityApp())).toEqual(expected);
  });

  it("keeps registered and documented operations equal after parameter normalization", () => {
    const app = createParityApp();
    expect(documentedOperations(app)).toEqual(
      actualOperations(routeDefinitions(app)),
    );
  });

  it("declares Clerk bearer auth on every private operation and not on health", () => {
    const routes = routeDefinitions(createParityApp());
    const health = routes.find(
      ({ method, path }) => method === "get" && path === "/health",
    );
    expect(health?.security).toBeUndefined();

    for (const route of routes.filter(({ path }) => path !== "/health")) {
      expect(route.security, `${route.method} ${route.path}`).toEqual([
        { bearerAuth: [] },
      ]);
    }
  });

  it("records the public webhook as the one relocated canonical behavior", () => {
    expect(
      sourceManifest.canonical
        .filter(({ target }) => target === "centsy")
        .map(({ method, path, target }) => ({ method, path, target })),
    ).toEqual([{ method: "POST", path: "/plaid/webhook", target: "centsy" }]);
  });

  it("registers all recurring aliases against the matching bills contracts as deprecated", () => {
    const routes = routeDefinitions(createParityApp());
    const byIdentity = new Map(
      routes.map((route) => [
        `${route.method.toUpperCase()} ${normalizePath(route.path)}`,
        route,
      ]),
    );

    expect(sourceManifest.aliases).toHaveLength(9);
    for (const alias of sourceManifest.aliases) {
      const aliasRoute = byIdentity.get(`${alias.method} ${alias.path}`);
      const canonicalRoute = byIdentity.get(
        `${alias.method} ${alias.canonicalPath}`,
      );
      expect(aliasRoute, `${alias.method} ${alias.path}`).toBeDefined();
      expect(
        canonicalRoute,
        `${alias.method} ${alias.canonicalPath}`,
      ).toBeDefined();
      expect(aliasRoute?.deprecated, `${alias.method} ${alias.path}`).toBe(
        true,
      );
      expect(aliasRoute?.security).toEqual(canonicalRoute?.security);
      expect(aliasRoute?.request).toEqual(canonicalRoute?.request);
      expect(aliasRoute?.responses).toEqual(canonicalRoute?.responses);
      expect(aliasRoute?.tags).toEqual(canonicalRoute?.tags);
    }
  });

  it("emits deprecation metadata for all nine aliases in OpenAPI", () => {
    const document = createOpenApiDocument(createParityApp()) as {
      paths: Record<string, Record<string, { deprecated?: boolean }>>;
    };

    for (const { method, path } of sourceManifest.aliases) {
      const openApiPath = path.replaceAll(/:([^/]+)/g, "{$1}");
      expect(
        document.paths[openApiPath]?.[method.toLowerCase()]?.deprecated,
        `${method} ${path}`,
      ).toBe(true);
    }
  });

  it("lists actual routes, aliases, and relocation in deterministic order", () => {
    const first = spawnSync("node", ["scripts/list-routes.mjs"], {
      encoding: "utf8",
    });
    const second = spawnSync("node", ["scripts/list-routes.mjs"], {
      encoding: "utf8",
    });

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toBe(first.stdout);

    const listed = JSON.parse(first.stdout) as Array<
      Operation & {
        disposition: "registered" | "relocated";
        identity: "canonical" | "alias";
        canonicalPath?: string;
        relocationTarget?: string;
      }
    >;
    expect(listed).toHaveLength(68);
    expect(
      listed.filter(({ identity }) => identity === "canonical"),
    ).toHaveLength(59);
    expect(listed.filter(({ identity }) => identity === "alias")).toHaveLength(
      9,
    );
    expect(
      listed.filter(({ disposition }) => disposition === "relocated"),
    ).toEqual([
      {
        method: "POST",
        path: "/plaid/webhook",
        disposition: "relocated",
        identity: "canonical",
        relocationTarget: "centsy",
      },
    ]);
    expect(listed).toEqual([...listed].sort(compareOperations));
  });
});
