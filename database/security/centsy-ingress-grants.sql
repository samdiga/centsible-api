-- Run as the API database owner after the deployment owner creates centsy_ingress.
-- The production application schema is public; this script intentionally does
-- not create, alter, or grant membership to the role.

GRANT USAGE ON SCHEMA public TO centsy_ingress;

GRANT INSERT (
  id,
  provider,
  webhook_type,
  webhook_code,
  provider_item_id,
  payload,
  payload_digest,
  dedupe_key,
  status,
  attempts,
  available_at
) ON TABLE public.inbound_webhook_events TO centsy_ingress;
