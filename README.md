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
