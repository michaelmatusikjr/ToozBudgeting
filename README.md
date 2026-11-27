# ToozBudgeting

A calm, zero-based budget for one person or a whole household. Works offline after the first load. Closed-app reminders are optional.

## Run it locally

Open `index.html` in a browser, or serve this folder with any static server so the service worker can register:

```
python3 -m http.server 8080
```

Then visit the address the server prints.

## GitHub Pages

1. Settings → Pages
2. Branch: `main`
3. Folder: `/ (root)`

The site is published at `https://michaelmatusikjr.github.io/ToozBudgeting/`. Paths are relative, so the `/ToozBudgeting/` subpath works without a build step.

Data is saved in IndexedDB on this device first (localStorage is only a fallback), so the app works offline. Export a JSON backup from Settings if you want a copy.

## Household accounts (optional)

Settings → Household → **Sign in with Google** shares one budget with everyone in the household, on every device. The server is the `toozbudgeting-bank` Worker in `worker-bank/`.

- **Who can join:** emails in the Worker's `ALLOWED_OWNER_EMAILS` become owners on first sign-in. Everyone else needs an invite: an owner opens Settings → Household → People, enters their Google email, and picks a role.
- **Roles:** **Owner** (everything, including people and banks), **Member** (edits the budget and syncs bank transactions), **View only** (read-only, enforced on the server). Members and viewers can also be limited to some budgets or categories (`scopes` on the membership; the server filters what they see and may change). A full permissions screen can come later; the data model and server checks are in place (`worker-bank/src/roles.js`).
- **Each person has a profile:** name and picture from Google, and a display name they can change.
- **Sync:** every change is saved on the device, then pushed to the household about 1.5 seconds later. The app pulls changes on open, when it comes back to the front, and every minute while open. Records are small (one transaction, one category, one month's amount for one category), and each carries its edit time, so two people editing different things never collide. If two people change the same thing at once, the later edit wins on every device. Deletes sync too.
- **First sign-in:** if the household is empty, this device's budget is uploaded and becomes the household's. If the household already has a budget, this device keeps a backup (Settings → Household → Download this device's old budget) and switches to the household's.
- **Signing out or Reset this device** only affects this device. Undo history clears when someone else's change arrives.
- Using the app without signing in (guest or device account) still works exactly as before, on that device only.
- The installed iPhone app signs in by redirect (popups don't return to a home-screen app); the Worker hands back a one-time code.

## Bank sync (optional)

Settings → Bank sync brings new transactions in from your banks through Plaid. It needs the separate `toozbudgeting-bank` Worker in `worker-bank/` (see its README) and a household sign-in. Owners connect banks with Plaid Link to connect a bank, and maps each bank account to an account or card here. New transactions arrive once for the whole household: one signed-in device claims them, applies them to the shared budget, and pushes the result. They come in when the app opens, on Sync now, and from the server's webhook and twice-daily check. Each one gets the id `plaid-<transaction_id>`, so it never imports twice. Reconciled transactions are never changed. A category guess is marked to confirm. Card payments use the existing Pay link, and transfers between your own banks become transfers. Only transactions on or after the "Bring in transactions from" date (2026-11-27 by default) come in. `oauth.html` is the return page for banks that sign in on their own site.

## Tests

```
npm test
```
