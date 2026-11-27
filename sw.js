const CACHE = "tooz-shell-v12";
const SHELL = [
  "./",
  "./index.html",
  "./css/styles.css",
  "./manifest.webmanifest",
  "./js/app.js",
  "./js/bankmap.js",
  "./js/banksync.js",
  "./js/calc.js",
  "./js/csv.js",
  "./js/mutate.js",
  "./js/notify.js",
  "./js/payees.js",
  "./js/push.js",
  "./js/pwa.js",
  "./js/store.js",
  "./js/ui.js",
  "./js/util.js",
  "./js/theme.js",
  "./js/whatsnew.js",
  "./js/views/accounts.js",
  "./js/views/bank.js",
  "./js/views/budget.js",
  "./js/views/gate.js",
  "./js/views/payees.js",
  "./js/views/settings.js",
  "./js/views/transactions.js",
  "./fonts/fraunces-600.woff2",
  "./fonts/source-sans-400.woff2",
  "./fonts/source-sans-600.woff2",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const cleanUrl = new URL(req.url);
  cleanUrl.search = "";
  const clean = new Request(cleanUrl.toString());
  try {
    const res = await fetch(new Request(req, { cache: "no-cache" }));
    if (res && res.ok) {
      cache.put(req, res.clone());
      cache.put(clean, res.clone());
    }
    return res;
  } catch {
    const hit = (await cache.match(req)) || (await cache.match(clean));
    if (hit) return hit;
    if (req.mode === "navigate") {
      const home = await cache.match("./index.html");
      if (home) return home;
    }
    return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
  }
}

function b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function openKeyDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("toozbudgeting-push", 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("kv")) req.result.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function reminderKey() {
  const db = await openKeyDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readonly");
      const req = tx.objectStore("kv").get("reminder");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

async function decrypt(ruleId, enc) {
  if (typeof enc !== "string" || enc.length < 12) return null;
  const rec = await reminderKey();
  const kid = enc.slice(0, 11);
  if (!rec?.key || rec.kid !== kid) return null;
  const bytes = b64urlToBytes(enc.slice(11));
  if (bytes.length < 13) return null;
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(ruleId) },
    rec.key,
    bytes.slice(12),
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

function safeUrl(url) {
  try {
    const u = new URL(url || "./", self.registration.scope);
    if (u.origin !== self.location.origin) return self.registration.scope;
    return u.href;
  } catch { return self.registration.scope; }
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; }
    catch { try { data = { body: event.data?.text() || "" }; } catch { data = {}; } }
    let title = "ToozBudgeting";
    let body = "Open your budget.";
    if (data.enc && data.id) {
      try {
        const plain = await decrypt(String(data.id), data.enc);
        if (plain?.title) title = String(plain.title).slice(0, 180);
        if (plain?.body) body = String(plain.body).slice(0, 400);
      } catch { /* generic copy */ }
    }
    await self.registration.showNotification(title, {
      body,
      tag: String(data.tag || data.id || "tooz").slice(0, 128),
      data: { url: safeUrl(data.url) },
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || self.registration.scope;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of all) {
      if (!client.url.startsWith(self.registration.scope)) continue;
      await client.focus();
      if ("navigate" in client) { try { await client.navigate(url); } catch { /* ignore */ } }
      return;
    }
    await self.clients.openWindow(url);
  })());
});
