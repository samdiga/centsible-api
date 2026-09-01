-- Add 'sync' to the audit_action enum so plaid.sync and plaid.balance.refresh
-- can record their work distinctly from generic 'update' operations.
-- Idempotent: ALTER TYPE ADD VALUE IF NOT EXISTS is a no-op when the value
-- already exists (Postgres 12+).

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'sync';
