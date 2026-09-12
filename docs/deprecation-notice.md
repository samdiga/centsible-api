# Draft: Centsible backend repository transition

**Draft only — do not publish yet.**

After a successful Plan 5 Task 5 cutover, `centsible-api` will replace the
backend API, domain, database-migration, and worker responsibilities currently
served from `centsible-claude`. Existing HTTP contracts remain in force except
for the already documented public Plaid webhook relocation: the old public
`POST /plaid/webhook` contract is now served as `POST /api/plaid/webhook` by
Centsy, which durably records verified deliveries for the `centsible-api`
worker.

`centsible-claude` retains a temporary application-rollback role. It is not yet
deprecated, stopped, or archived. Publication requires a successful Task 5
cutover; archival requires the seven-day Task 6 soak to pass.

Operators should use:

- [API and worker operations](operations.md)
- [Task 5 cutover checklist](cutover-checklist.md)
- [Rollback checklist](rollback-checklist.md)
- [Centsy webhook contract](centsy-webhook-contract.md)

After those gates pass, backend work belongs in `centsible-api`, mobile work in
`centsible-ui`, and public web work in Centsy.
