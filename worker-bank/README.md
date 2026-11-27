# toozbudgeting-bank

Plaid bank sync for ToozBudgeting. It runs on its own Worker with its own D1 database, separate from `toozbudgeting-push`, so a problem here can't affect reminders.

- **Live URL:** `https://toozbudgeting-bank.michael-matusik-jr.workers.dev`
- **D1:** `toozbudgeting-bank` (schema in `schema.sql`)
- **Cron:** `0 11,23 * * *` (twice a day, as a backup to Plaid's webhooks)

## How it works

1. A device pairs with `PAIRING_SECRET`. It sends a P-256 public key and gets a device token. The server stores only a hash of the token.
2. The app asks for a Plaid Link token (`POST /bank/link-token`) and opens Plaid Link. The bank sign-in goes to Plaid only.
3. The app sends the `public_token` to `POST /bank/exchange`. The Worker swaps it for an access token, encrypts that with `TOKEN_ENC_KEY` (AES-GCM, bound to the item id), and stores it.
4. Plaid calls `POST /bank/webhook` with `SYNC_UPDATES_AVAILABLE`. The Worker checks the signed JWT (ES256 key from `/webhook_verification_key/get`, `iat` within 5 minutes, and the SHA-256 of the body), then follows `/transactions/sync` from the saved cursor.
5. Changes go into a per-device inbox, encrypted to each device's public key (ephemeral ECDH, HKDF-SHA256, AES-GCM). The cursor moves only after the inbox write, so a failure re-sends rather than loses.
6. The app pulls `GET /bank/inbox`, applies the changes locally (one undoable commit), and acks with `POST /bank/ack`.

The free Plaid Trial allows **10 Items (bank logins) for the life of the account**. Removing one does not give the slot back, so:

- `POST /bank/link-token` refuses a new login once `items_created` reaches `ITEM_CAP`. Reconnect (update mode) still works.
- The app closes Link when you pick a bank that's already connected, before a login is created.
- `POST /bank/exchange` refuses a second login at the same institution and removes it.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/bank/health` | none | Config check (booleans only, never values) |
| POST | `/bank/pair` | pairing secret | Register a device public key, get a token (10 wrong tries per IP per hour) |
| POST | `/bank/link-token` | device | New Link token, or `{ itemId }` for Reconnect |
| POST | `/bank/exchange` | device | Swap a `public_token`, store the encrypted access token |
| GET | `/bank/items` | device | Banks, status, accounts, and `used`/`cap` |
| POST | `/bank/items/:id/repaired` | device | After Reconnect: clear flags and sync |
| DELETE | `/bank/items/:id` | device | `/item/remove` (the slot is not returned) |
| POST | `/bank/sync` | device | Sync now |
| GET | `/bank/inbox` | device | Encrypted batches for this device |
| POST | `/bank/ack` | device | Delete delivered batches |
| DELETE | `/bank/device` | device | Unpair |
| POST | `/bank/webhook` | Plaid JWT | Plaid webhooks |

Status flags: `ok`, `login_required` (ITEM_LOGIN_REQUIRED and similar), `expiring` (PENDING_EXPIRATION / PENDING_DISCONNECT), `error`. `NEW_ACCOUNTS_AVAILABLE` sets `newAccounts`.

CORS allows only `ALLOWED_ORIGINS`. A request with any other `Origin` gets 403.

## Settings

Vars (in `wrangler.toml`): `ALLOWED_ORIGINS`, `PLAID_ENV`, `REDIRECT_URI`, `DAYS_REQUESTED`, `ITEM_CAP`.

Secrets (never committed):

```
npx wrangler secret put PLAID_CLIENT_ID
npx wrangler secret put PLAID_SECRET
npx wrangler secret put TOKEN_ENC_KEY    # 32 random bytes, base64url
npx wrangler secret put PAIRING_SECRET   # the code you type in Settings > Bank sync
```

`REDIRECT_URI` must also be listed under **Allowed redirect URIs** in the Plaid dashboard (Developers > API). Until it is, the Worker retries without it and tells the app. Banks that sign in on their own site (OAuth) may then not finish on a phone.

## Deploy

```
npx wrangler d1 execute toozbudgeting-bank --remote --file=schema.sql
npx wrangler deploy
```

## Tests

```
node --test worker-bank/test/*.test.mjs
```

The tests run the real handlers against an in-memory SQLite D1 and a mocked Plaid, so no real bank logins are created.
