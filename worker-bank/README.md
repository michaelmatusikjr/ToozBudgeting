# toozbudgeting-bank

Household accounts, shared budget sync, and Plaid bank sync for ToozBudgeting. It runs on its own Worker with its own D1 database, separate from `toozbudgeting-push`, so a problem here can't affect reminders.

- **Live URL:** `https://toozbudgeting-bank.michael-matusik-jr.workers.dev`
- **D1:** `toozbudgeting-bank` (schema in `schema.sql`)
- **Cron:** `0 11,23 * * *` (twice a day, as a backup to Plaid's webhooks; also cleans expired sessions)

## How it works

**Household accounts**

1. The app shows Google's Sign in with Google button (Google Identity Services) and sends the ID token to `POST /auth/google`.
2. The Worker checks it against Google's published keys (`https://www.googleapis.com/oauth2/v3/certs`, cached by `max-age`): RS256 signature, `aud` = `GOOGLE_CLIENT_ID`, `iss` = accounts.google.com, not expired, verified email.
3. It finds the person's household: an existing membership, else a pending invite for that email, else an owner email from `ALLOWED_OWNER_EMAILS` (the first one creates the household). Anyone else gets 403 `NOT_INVITED`.
4. It returns a session token (`s_<id>.<secret>`, 180 days, sliding). Only a SHA-256 of the secret is stored. The app sends it as `Authorization: Bearer`.
5. The installed iPhone app uses Google's redirect mode: Google posts to `/auth/google/redirect`, the Worker redirects back to `APP_URL#signin=<code>`, and the app trades the one-time code (2 minutes) at `POST /auth/redeem`.

**Roles** (`src/roles.js`): `owner` (everything), `member` (read and write the budget, apply bank transactions), `viewer` (read-only). Optional `scopes` limit members and viewers to some budgets (`{ "budgets": [...] }`) or categories (`{ "categories": { "<budgetId>": [...] } }`). Members can't change a budget's `bankLinks` or delete a budget. Changing someone's role or scopes bumps `access_rev`, and their app re-pulls from the start.

**Shared budget** (`src/sync.js`): the app's records (budget header, account, card, group, category, transaction, payee, month marker, month-and-category amount, inflow, note, reminder) are stored one row per record per household in `records`. Each has the edit time `t` and device `dev`. Last write wins per record by `(t, dev)`, and deletes are tombstones. Each push bumps the household's `seq` and writes the rows in one D1 batch (a single transaction), so `GET /sync/pull?since=<seq>` never skips a change. A push answers with any record the server kept instead (a newer edit by someone else, a clamped future clock, or owner-only fields), so the device converges right away.

**Bank sync**

1. An owner asks for a Plaid Link token (`POST /bank/link-token`) and opens Plaid Link. The bank sign-in goes to Plaid only.
2. The app sends the `public_token` to `POST /bank/exchange`. The Worker swaps it for an access token, encrypts that with `TOKEN_ENC_KEY` (AES-GCM, bound to the item id), and stores it with the household.
3. Plaid calls `POST /bank/webhook` with `SYNC_UPDATES_AVAILABLE`. The Worker checks the signed JWT (ES256 key from `/webhook_verification_key/get`, `iat` within 5 minutes, and the SHA-256 of the body), then follows `/transactions/sync` from the saved cursor.
4. Changes go into the household's bank inbox, encrypted at rest with `TOKEN_ENC_KEY`. The cursor moves only after the inbox write, so a failure re-sends rather than loses.
5. A signed-in owner or member's app claims waiting batches (`GET /bank/inbox`, a 2-minute claim so two devices don't apply the same ones), applies them to the shared budget in one undoable commit, pushes the budget, then acks (`POST /bank/ack`). Batches for bank accounts nobody has mapped yet go back in the inbox (`held`) for whichever device maps them first. Transaction ids are `plaid-<transaction_id>`, so applying twice never duplicates.

The free Plaid Trial allows **10 Items (bank logins) for the life of the account**. Removing one does not give the slot back, so:

- `POST /bank/link-token` refuses a new login once `items_created` reaches `ITEM_CAP`. Reconnect (update mode) still works.
- The app closes Link when you pick a bank that's already connected, before a login is created.
- `POST /bank/exchange` refuses a second login at the same institution and removes it.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | none | Config check (booleans only, never values) |
| GET | `/auth/config` | none | The Google client ID for the button (public) |
| POST | `/auth/google` | Google ID token | Sign in, get a session (20 bad tries per IP per hour) |
| POST | `/auth/google/redirect` | Google form post | Redirect sign-in for the installed iPhone app |
| POST | `/auth/redeem` | one-time code | Trade the redirect code for a session |
| POST | `/auth/logout` | session | Sign out this device (`?all=1` for every device) |
| GET, PATCH | `/me` | session | Who's signed in, household, role; change display name |
| PATCH | `/household` | owner | Rename the household |
| GET | `/household/members` | session | People (and pending invites, for owners) |
| PATCH, DELETE | `/household/members/:userId` | owner | Change role or scopes; remove (anyone can remove themselves) |
| POST | `/household/invites` | owner | Invite an email with a role (14 days) |
| DELETE | `/household/invites/:id` | owner | Cancel an invite |
| POST | `/sync/push` | owner, member | Upload changed records |
| GET | `/sync/pull?since=` | session | Records changed since a seq |
| POST | `/bank/link-token` | owner | New Link token, or `{ itemId }` for Reconnect |
| POST | `/bank/exchange` | owner | Swap a `public_token`, store the encrypted access token |
| GET | `/bank/items` | session | Banks, status, accounts, and `used`/`cap` |
| POST | `/bank/items/:id/repaired` | owner | After Reconnect: clear flags and sync |
| DELETE | `/bank/items/:id` | owner | `/item/remove` (the slot is not returned) |
| POST | `/bank/sync` | owner, member | Sync now |
| GET | `/bank/inbox` | owner, member | Claim waiting batches |
| POST | `/bank/ack` | owner, member | Done, release, or hold batches |
| POST | `/bank/webhook` | Plaid JWT | Plaid webhooks |

Status flags: `ok`, `login_required` (ITEM_LOGIN_REQUIRED and similar), `expiring` (PENDING_EXPIRATION / PENDING_DISCONNECT), `error`. `NEW_ACCOUNTS_AVAILABLE` sets `newAccounts`.

CORS allows only `ALLOWED_ORIGINS`. A request with any other `Origin` gets 403.

## Settings

Vars (in `wrangler.toml`): `ALLOWED_ORIGINS`, `APP_URL`, `PLAID_ENV`, `REDIRECT_URI`, `DAYS_REQUESTED`, `ITEM_CAP`.

Set in the dashboard (Workers → toozbudgeting-bank → Settings → Variables and Secrets):

- `GOOGLE_CLIENT_ID` (Text): the OAuth **Web application** client ID from Google Cloud. It is public. `keep_vars = true` keeps it across `wrangler deploy`.
- Secrets: `PLAID_CLIENT_ID`, `PLAID_SECRET`, `TOKEN_ENC_KEY` (32 random bytes, base64url), `ALLOWED_OWNER_EMAILS` (comma-separated Google emails that become owners on first sign-in).

`PAIRING_SECRET` is no longer used and can be deleted.

Google Cloud: the OAuth client needs **Authorized JavaScript origin** `https://michaelmatusikjr.github.io` and **Authorized redirect URI** `https://toozbudgeting-bank.michael-matusik-jr.workers.dev/auth/google/redirect` (the second is only for the installed iPhone app).

`REDIRECT_URI` must also be listed under **Allowed redirect URIs** in the Plaid dashboard (Developers > API). Until it is, the Worker retries without it and tells the app. Banks that sign in on their own site (OAuth) may then not finish on a phone.

## Deploy

```
# existing v1 database, once:
npx wrangler d1 execute toozbudgeting-bank --remote --file=migrations/0002_households.sql
# every time (safe to repeat):
npx wrangler d1 execute toozbudgeting-bank --remote --file=schema.sql
npx wrangler deploy
```

## Tests

```
node --test worker-bank/test/*.test.mjs
```

The tests run the real handlers against an in-memory SQLite D1, a mocked Plaid, and a fake Google that signs ID tokens with a test RSA key, so no real bank logins or Google accounts are used.


## v2.0.1: sign-in reason codes and Plaid webhooks

- **Installed iPhone app sign-in** uses `GET /auth/google/start`, which sends the app to Google's OpenID Connect page
  (`response_type=id_token`, `response_mode=form_post`). Google posts `id_token` + `state` to `/auth/google/redirect`;
  the state is sealed with `TOKEN_ENC_KEY` and carries a nonce the ID token must repeat. The Sign in with Google button's
  own redirect post (`credential`) is still accepted.
- **Reason codes.** Every sign-in failure returns `{ error, code }` (JSON) or `#signin-error=…&signin-code=CODE` (redirect),
  and the app shows "Message (CODE)". Codes: `NO_CREDENTIAL`, `BAD_TOKEN`, `BAD_ALG`, `UNKNOWN_KEY`, `BAD_SIGNATURE`,
  `WRONG_ISSUER`, `WRONG_AUDIENCE`, `EXPIRED`, `CLOCK`, `BAD_NONCE`, `BAD_STATE`, `STATE_EXPIRED`, `EMAIL_UNVERIFIED`,
  `NOT_INVITED`, `JWKS_UNREACHABLE`, `GOOGLE_<error>`, `CODE_EXPIRED`. `/health` shows `lastSignInError`
  (time, code, flow, form field names, device family; never tokens). Worker logs are on (Workers Observability).
- **Plaid webhooks** go to `POST /plaid/webhook` (`/bank/webhook` still works). Link tokens set it; Items registered with
  another URL get `/item/webhook/update` from the cron or Sync now. Every webhook is verified (ES256 `Plaid-Verification`
  JWT from `/webhook_verification_key/get`, fresh `iat`, body SHA-256). `SYNC_UPDATES_AVAILABLE` runs
  `/transactions/sync` for that Item; `ITEM` `ERROR`, `PENDING_EXPIRATION`, `PENDING_DISCONNECT`, `USER_PERMISSION_REVOKED`,
  `LOGIN_REPAIRED`, `NEW_ACCOUNTS_AVAILABLE` update the Item's status for the app. The twice-daily cron stays as a backup.
- Migration: `migrations/0003_webhooks.sql` (adds `items.webhook_url`, `items.last_webhook_code`). `PUBLIC_URL` is set in `wrangler.toml`.
