# centsible-api

API service for the Centsible app.

## Local network binding

The API defaults to `127.0.0.1:4000`, which is appropriate for same-host
access or when `tailscale serve` proxies the listener. For direct access from
the Swift app over Tailscale, set `API_HOST` to the Mac mini's Tailscale IP and
keep `PORT=4000`. Only loopback and Tailscale IP literals are accepted; do not
guess or commit the machine's address.

## Operator runbooks

Plan 5 Task 4 is a sandbox rehearsal only. It must use an isolated
`centsible_test_<run-id>` schema and non-production ports; port `4000` remains
untouched until a separate, explicit Task 5 cutover approval.

- [API and worker operations](docs/operations.md)
- [Task 5 cutover checklist](docs/cutover-checklist.md)
- [Rollback checklist](docs/rollback-checklist.md)
- [Draft deprecation notice](docs/deprecation-notice.md)
