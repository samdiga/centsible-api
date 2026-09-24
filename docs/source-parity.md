# Source parity

Plan 5 Task 1 compares this package with the approved source pin
`06d3972a7ffc88b6c65a4bab4ad47487e55b800c` and only these supplemental
account commits:

- `ca000fbb1f1755e77b22970ba6ff11ce520aa4ea`
- `32515278be92347635081bac76cf1766bb563189`
- `423879917c74cce21ccafa606279cc0511d4da91`

## Source tests

`tests/contract/source-test-mapping.json` records 52 unique source test paths:
40 base-pin API files, 11 base-pin shared-support files, and one supplemental-only
accounts service file. The base accounts repository test is recorded once with
the base SHA and both commits that changed it. The mapping contains 77 exact
target references across 56 unique target files; 75 references are in
`centsible-api` and two are in `centsy`.

Mappings were selected from the source and target test behaviors, not filename
similarity. Repository and service suites that were reorganized into vertical
slices can therefore point to more than one exact unit or isolated-integration
test. `PlaidServiceError` terminal classification had no direct target assertion,
so its pinned cases are retained in the mapping contract test.

## HTTP and OpenAPI surface

The approved source manifest contains 55 canonical behaviors pinned to the
source commit above. The private API registers 54 of those canonical
operations plus nine deprecated `/recurring` aliases. The remaining pinned
canonical behavior, public `POST /plaid/webhook`, is explicitly relocated to
Centsy.

Eight canonical entries (`GET /tags`, `POST /tags`, `PATCH /tags/:id`,
`DELETE /tags/:id`, `POST /rules/:id/apply`, `GET /dashboard/net-worth/history`,
`PUT /notifications/push-token`, `DELETE /notifications/push-token`) are marked
`pinned: false` in the route manifest — the Tags feature, the Rules Engine
retroactive-apply route, the net-worth history route, and the push-token
registration endpoints were all added after the source pin and have no file
in that pinned tree by definition. `scripts/verify-source-pin.mjs` excludes
`pinned: false` entries from its pinned-source file-existence check for
exactly this reason, while still verifying every entry it does claim came
from the pin actually exists there. Including these eight, the manifest's
`canonical` array totals 63 entries (55 pinned + 8 post-migration).

`scripts/list-routes.mjs` constructs the HTTP application and reads its actual
Hono route registrations. The source manifest is used only to classify the
registered aliases and append explicitly approved relocations. Output is sorted
by normalized path and method and contains 72 records: 62 registered canonical
(54 pinned + 8 post-migration), nine registered aliases, and one relocated
canonical behavior.

The parity contract normalizes Hono `:param` and OpenAPI `{param}` paths, rejects
missing, extra, or duplicate operation definitions, compares registered and
documented operations, rejects extra plain Hono routes, requires bearer security on every private operation,
keeps `GET /health` unauthenticated, and requires all alias operations to carry
OpenAPI `deprecated: true` metadata.

## Deliberate and corrected differences

- `POST /plaid/webhook` is deliberately absent from the private API. Centsy owns
  public signature/body verification and durable ingress; the API worker owns
  verified-event dispatch. The exact target tests are recorded in the mapping.
- The migrated API standardizes typed error envelopes. That approved behavioral
  standardization is exercised by existing route tests and is not a route-count
  difference.
- Task 1 found one unintended parity difference: `GET /health` was a registered,
  unauthenticated Hono route but was absent from OpenAPI. It now uses an
  unauthenticated OpenAPI route definition with the same path and response body.

This document records contract evidence only. It does not claim clean-install,
live-database, deployment, cutover, or production verification.
