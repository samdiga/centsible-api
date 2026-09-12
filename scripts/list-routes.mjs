#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { tsImport } from "tsx/esm/api";

const { createHttpApp } = await tsImport(
  "../src/app/create-http-app.ts",
  import.meta.url,
);
const sourceManifest = JSON.parse(
  await readFile(
    new URL("../tests/contract/source-route-manifest.json", import.meta.url),
    "utf8",
  ),
);

const normalizePath = (path) => path.replaceAll(/\{([^}]+)\}/g, ":$1");
const compare = (left, right) =>
  left.path.localeCompare(right.path) ||
  left.method.localeCompare(right.method);
const aliases = new Map(
  sourceManifest.aliases.map(({ method, path, canonicalPath }) => [
    `${method} ${path}`,
    canonicalPath,
  ]),
);

const app = createHttpApp({ auth: async (_context, next) => next() });
const actualRoutes = new Map();
for (const route of app.routes) {
  if (route.method === "ALL") continue;
  const method = route.method.toUpperCase();
  const path = normalizePath(route.path);
  actualRoutes.set(`${method} ${path}`, { method, path });
}
const registered = [...actualRoutes.values()].map(({ method, path }) => {
  const canonicalPath = aliases.get(`${method} ${path}`);
  return canonicalPath
    ? {
        method,
        path,
        disposition: "registered",
        identity: "alias",
        canonicalPath,
      }
    : {
        method,
        path,
        disposition: "registered",
        identity: "canonical",
      };
});
const relocated = sourceManifest.canonical
  .filter(({ target }) => target !== undefined)
  .map(({ method, path, target }) => ({
    method,
    path,
    disposition: "relocated",
    identity: "canonical",
    relocationTarget: target,
  }));

process.stdout.write(
  `${JSON.stringify([...registered, ...relocated].sort(compare), null, 2)}\n`,
);
