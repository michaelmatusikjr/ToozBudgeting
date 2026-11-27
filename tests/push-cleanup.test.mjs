import { test } from "node:test";
import assert from "node:assert/strict";

if (!globalThis.window || !globalThis.window.addEventListener) {
  globalThis.window = new Proxy(globalThis, {
    get(target, prop) {
      if (prop === "addEventListener" || prop === "removeEventListener") return () => {};
      return target[prop];
    },
  });
}
if (!globalThis.document) {
  globalThis.document = { documentElement: { style: { setProperty() {} } }, addEventListener() {}, readyState: "complete" };
}
const mem = new Map();
if (!globalThis.localStorage) {
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
}

let unsubCount = 0;
const sub = {
  endpoint: "https://push.example/sub",
  unsubscribe: async () => { unsubCount++; return true; },
  toJSON: () => ({ endpoint: "https://push.example/sub" }),
};
const sw = {
  getRegistration: async () => ({ pushManager: { getSubscription: async () => (unsubCount ? null : sub) } }),
};
try {
  Object.defineProperty(globalThis.navigator, "serviceWorker", { configurable: true, writable: true, value: sw });
} catch {
  globalThis.navigator.serviceWorker = sw;
}
globalThis.fetch = async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });

const { pushCleanupOnce } = await import("../js/push.js?v=154");
const { deviceSet } = await import("../js/store.js?v=154");

test("pushCleanupOnce unsubscribes once and then never again", async () => {
  await deviceSet("pushRemoved", null);
  unsubCount = 0;
  await pushCleanupOnce();
  assert.equal(unsubCount, 1);
  await pushCleanupOnce();
  await pushCleanupOnce();
  assert.equal(unsubCount, 1, "already cleaned up");
});
