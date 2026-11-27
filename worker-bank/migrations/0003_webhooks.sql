-- v2.0.1: Plaid webhooks point at /plaid/webhook. Track which URL each Item is registered with and the last event.
ALTER TABLE items ADD COLUMN webhook_url TEXT;
ALTER TABLE items ADD COLUMN last_webhook_code TEXT;
