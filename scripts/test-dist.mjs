import assert from "node:assert/strict";

const { createHttpApp } = await import("../dist/app/create-http-app.js");
const app = createHttpApp();
const response = await app.request("/health");
const body = await response.json();

assert.equal(response.status, 200);
assert.equal(body.status, "ok");
assert.equal(body.service, "centsible-api");
assert.match(body.timestamp, /^\d{4}-\d{2}-\d{2}T/);

const { createWorker } = await import("../dist/app/create-worker.js");
const worker = createWorker({ adapters: [{ enabled: false }] });
await worker.start();
await worker.stop();
