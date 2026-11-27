# ToozBudgeting

A calm, zero-based budget that lives on your device. Works offline after the first load. Closed-app reminders are optional.

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

Data stays in IndexedDB on this device (localStorage is only a fallback). Export a JSON backup from Settings if you want a copy.

## Bank sync (optional)

Settings → Bank sync brings new transactions in from your banks through Plaid. It needs the separate `toozbudgeting-bank` Worker in `worker-bank/` (see its README). The app pairs with the Worker, opens Plaid Link to connect a bank, and maps each bank account to an account or card here. New transactions come in when the app opens, on Sync now, and from the server's webhook and twice-daily check. Each one gets the id `plaid-<transaction_id>`, so it never imports twice. Reconciled transactions are never changed. A category guess is marked to confirm. Card payments use the existing Pay link, and transfers between your own banks become transfers. Only transactions on or after the "Bring in transactions from" date (2026-11-27 by default) come in. `oauth.html` is the return page for banks that sign in on their own site.

## Tests

```
npm test
```
