/** Install prompt, platform detection, service worker updates. */

export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

let deferred = null;
const waiters = new Set();

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferred = e;
  waiters.forEach((fn) => fn(true));
});

export function onInstallable(fn) { waiters.add(fn); return () => waiters.delete(fn); }
export const canInstall = () => !!deferred;

export async function promptInstall() {
  if (!deferred) return { ok: false, reason: isIOS() ? "ios" : "unavailable" };
  deferred.prompt();
  const choice = await deferred.userChoice;
  deferred = null;
  return { ok: choice?.outcome === "accepted" };
}

export async function registerSW(onWaiting) {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.register("./sw.js?v=151");
  const watch = () => { if (reg.waiting) onWaiting?.(reg); };
  watch();
  reg.addEventListener("updatefound", () => {
    const nw = reg.installing;
    nw?.addEventListener("statechange", () => { if (nw.state === "installed" && navigator.serviceWorker.controller) onWaiting?.(reg); });
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  return reg;
}

export function activateWaiting(reg) {
  reg?.waiting?.postMessage({ type: "SKIP_WAITING" });
}
