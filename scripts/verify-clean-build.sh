#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"
index_tree="$(git write-tree)"
temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/centsible-api-clean-build.XXXXXX")"

cleanup() {
  status=$?
  trap - EXIT
  if [ "$status" -eq 0 ]; then
    rm -rf "$temporary_directory"
  else
    printf 'Clean-build verification failed; retained temporary directory: %s\n' "$temporary_directory" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

git archive "$index_tree" | tar -x -C "$temporary_directory"
cd "$temporary_directory"

pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test --
pnpm build
pnpm test:dist
