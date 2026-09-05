# Task 7: Budgets domain

## Result

Implemented the budgets domain in the `api-domains` worktree and registered all
seven canonical budget operations. The implementation uses the package's
OpenAPIHono route boundary, `validateOutput`, typed errors, injected repository
and service interfaces, revisioned response caching, and `withUserMutation`.

## Source mapping

Lifted and adapted from pinned source commit
`06d3972a7ffc88b6c65a4bab4ad47487e55b800c`:

- `apps/api/src/routes/budgets.ts` -> `src/modules/budgets/budgets.routes.ts`
- `apps/api/src/repos/budgets.ts` -> `src/modules/budgets/budgets.repository.ts`
- `apps/api/src/services/budgets/index.ts` -> `src/modules/budgets/budgets.service.ts`
- `packages/shared-types/src/budget.ts` -> `src/modules/budgets/budgets.schemas.ts`
- `packages/shared-logic/src/budgets/index.ts` -> `src/modules/budgets/budget-calculations.ts`

`src/modules/budgets/budgets.mapper.ts` and the package index provide the
current repository's domain-local DTO and public composition boundaries.

## Required behavior

- Registered `GET /budgets/suggestions`, `GET /budgets/active`, `POST /budgets`,
  `GET /budgets/{id}/progress`, `PUT /budgets/{id}/items`,
  `PATCH /budgets/active/items/{categoryId}`, and
  `DELETE /budgets/active/items/{categoryId}`.
- All wire money fields are signed decimal-integer strings; database bigint
  values are converted in the mapper/service boundary.
- Suggestions, active budget, and progress are cached with user revision and
  normalized route/query keys.
- Create, replace, upsert, and delete use one user-mutation transaction each;
  category and active-budget ownership checks occur on that transaction before
  writes. Replacement is delete/insert atomic, including direct repository use.
- Audit snapshots serialize bigint values before JSONB insertion.
- Missing active budgets/progress and foreign budget/category references return
  typed not-found errors.

## TDD evidence

RED:

```text
pnpm exec vitest run src/modules/budgets/tests --no-file-parallelism
3 failures: budget-calculations module was absent; budget routes were not
registered and returned the route not-found envelope.
```

GREEN:

```text
pnpm test src/modules/budgets
2 files passed, 6 tests passed
```

The focused route tests cover active-budget not-found behavior, creation,
signed money output, and revision advancement through one deletion mutation.
Calculation tests cover monthly periods, spending aggregation, ignored
inflows/unassigned transactions, and over-budget negative remaining values.

## Verification

```text
pnpm test
45 files passed, 244 tests passed

pnpm exec vitest run tests/integration/budgets --no-file-parallelism
1 file skipped, 2 tests skipped
Reason: no approved Neon/test database inputs were present in this shell.

pnpm typecheck
passed

pnpm lint
passed

pnpm format:check
passed

pnpm build
passed

pnpm test:dist
passed
```

## Remaining concerns

- Neon-backed repository behavior was not exercised in this environment. Run
  the guarded integration file with approved test database inputs before
  relying on live SQL behavior.
- Monthly periods are implemented as in the pinned source; biweekly and weekly
  periods remain explicitly unsupported by the shared calculation function.
- Concurrent budget creation still relies on the database's partial unique
  active-budget index; a dedicated multi-session race test is outside this
  task's available Neon verification.
