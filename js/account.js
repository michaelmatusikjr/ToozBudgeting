/**
 * Household account: Sign in with Google, the session token, and the household API.
 * The server is the toozbudgeting-bank Worker. The session token lives in IndexedDB on this device only.
 */
import { deviceGet, deviceSet } from "./store.js?v=140";

export const SERVER_DEFAULT = "https://toozbudgeting-bank.michael-matusik-jr.workers.dev";
const GIS_SRC = "https://accounts.google.com/gsi/client";
const listeners = new Set();

export function onAccountChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const changed = () => listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });

export class ApiError extends Error { constructor(status, message, data) { super(message); this.status = status; this.data = data; } }

/** Server address. Shared with bank sync, which runs on the same Worker. */
export async function serverUrl() {
  const o = (await deviceGet("bankConfig")) || {};
  return String(o.serverUrl || SERVER_DEFAULT).trim().replace(/\/+$/, "");
}

/** { token, me, at } or null. me = { user, household, role, scopes, accessRev } */
export async function account() { return (await deviceGet("account")) || null; }
export async function isSignedIn() { return !!(await account())?.token; }

async function saveAccount(next) {
  await deviceSet("account", next);
  changed();
  return next;
}

export async function api(method, path, body, { auth = true, token } = {}) {
  const base = await serverUrl();
  const headers = body === undefined ? {} : { "Content-Type": "application/json" };
  if (auth) {
    const t = token || (await account())?.token;
    if (!t) throw new ApiError(401, "Sign in first", { code: "SIGNED_OUT" });
    headers.Authorization = "Bearer " + t;
  }
  let res;
  try {
    res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), mode: "cors" });
  } catch { throw new ApiError(0, navigator.onLine ? "Can’t reach the sync server" : "You’re offline"); }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (auth && (res.status === 401 || data?.code === "REMOVED")) await markSignedOut(data?.error);
    throw new ApiError(res.status, data?.error || `HTTP ${res.status}`, data);
  }
  return data;
}

async function markSignedOut(reason) {
  const a = await account();
  if (!a?.token) return;
  await saveAccount({ ...a, token: null, signedOutReason: reason || "You were signed out." });
}

export async function authConfig() {
  try { return await api("GET", "/auth/config", undefined, { auth: false }); }
  catch (e) { return { ready: false, googleClientId: null, error: e.message }; }
}

function deviceName() {
  const ua = navigator.userAgent || "";
  const standalone = matchMedia?.("(display-mode: standalone)")?.matches || navigator.standalone;
  const what = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Browser";
  return standalone ? `${what} app` : what;
}

async function finishSignIn(res) {
  const prev = await account();
  const sameHousehold = prev?.me?.household?.id === res.me?.household?.id && prev?.me?.user?.id === res.me?.user?.id;
  return saveAccount({
    token: res.token, me: res.me, at: Date.now(), signedOutReason: null,
    // A different person or household on this device starts sync from scratch.
    cursor: sameHousehold ? (prev.cursor || 0) : 0,
    accessRev: sameHousehold ? prev.accessRev : res.me.accessRev,
    linked: sameHousehold ? !!prev.linked : false,
  });
}

/** Trade a Google ID token (from the Sign in with Google button) for a household session. */
export async function signInWithCredential(credential) {
  const res = await api("POST", "/auth/google", { credential, deviceName: deviceName() }, { auth: false });
  return finishSignIn(res);
}

/** The installed iPhone app signs in by redirect; the Worker sends us back with #signin=<one-time code>. */
export async function redeemSignInCode(code) {
  const res = await api("POST", "/auth/redeem", { code }, { auth: false });
  return finishSignIn(res);
}

export async function refreshMe() {
  const a = await account();
  if (!a?.token) return null;
  const me = await api("GET", "/me");
  const next = await saveAccount({ ...(await account()), me });
  return next;
}

export async function patchAccount(patch) { return saveAccount({ ...(await account()), ...patch }); }

export async function signOut() {
  try { await api("POST", "/auth/logout", {}); } catch { /* already gone */ }
  await saveAccount(null);
}

export const listMembers = () => api("GET", "/household/members");
export const invite = (email, role, scopes) => api("POST", "/household/invites", { email, role, scopes });
export const revokeInvite = (id) => api("DELETE", `/household/invites/${encodeURIComponent(id)}`);
export const setMember = (userId, patch) => api("PATCH", `/household/members/${encodeURIComponent(userId)}`, patch);
export const removeMember = (userId) => api("DELETE", `/household/members/${encodeURIComponent(userId)}`);
export const setMyName = (displayName) => api("PATCH", "/me", { displayName });
export const renameHousehold = (name) => api("PATCH", "/household", { name });

export const ROLE_LABEL = { owner: "Owner", member: "Member", viewer: "View only" };
export const ROLE_HINT = {
  owner: "Everything, including people and banks.",
  member: "Edits the budget and brings in bank transactions. Can’t manage people or banks.",
  viewer: "Sees the budget. Can’t change anything.",
};

/* ---------- Google Identity Services ---------- */

let gis = null;
function loadGis() {
  if (window.google?.accounts?.id) return Promise.resolve(window.google);
  if (gis) return gis;
  gis = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = GIS_SRC; el.async = true;
    el.onload = () => (window.google?.accounts?.id ? resolve(window.google) : reject(new Error("Google sign-in didn’t load")));
    el.onerror = () => { gis = null; reject(new Error("Couldn’t load Google sign-in. Check your connection.")); };
    document.head.append(el);
  });
  return gis;
}

const isStandaloneIOS = () => /iPhone|iPad/.test(navigator.userAgent || "") && (navigator.standalone || matchMedia?.("(display-mode: standalone)")?.matches);

/**
 * Put the official Sign in with Google button in host. onSignedIn(account) runs after the server accepts it.
 * The installed iPhone app uses redirect mode, because popups there don't come back to the app.
 */
export async function renderGoogleButton(host, { onSignedIn, onError } = {}) {
  const cfg = await authConfig();
  if (!cfg.ready) {
    host.replaceChildren(Object.assign(document.createElement("p"), { className: "hint", textContent: cfg.error ? `${cfg.error}. Sign-in will show here when it’s back.` : "Google sign-in isn’t set up on the server yet." }));
    return false;
  }
  let google;
  try { google = await loadGis(); }
  catch (e) { onError?.(e.message); return false; }
  const redirect = isStandaloneIOS();
  google.accounts.id.initialize({
    client_id: cfg.googleClientId,
    auto_select: false,
    cancel_on_tap_outside: true,
    ux_mode: redirect ? "redirect" : "popup",
    login_uri: redirect ? (await serverUrl()) + "/auth/google/redirect" : undefined,
    callback: async (resp) => {
      try { onSignedIn?.(await signInWithCredential(resp.credential)); }
      catch (e) { onError?.(e.message); }
    },
  });
  host.replaceChildren();
  const width = Math.min(360, Math.max(220, host.clientWidth || 320));
  google.accounts.id.renderButton(host, { type: "standard", theme: "outline", size: "large", text: "signin_with", shape: "pill", logo_alignment: "left", width });
  return true;
}
