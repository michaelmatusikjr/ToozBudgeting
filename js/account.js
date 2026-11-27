/**
 * Household account: Sign in with Google, the session token, and the household API.
 * The server is the toozbudgeting-bank Worker. The session token lives in IndexedDB on this device only.
 */
import { deviceGet, deviceSet } from "./store.js?v=152";

export const SERVER_DEFAULT = "https://toozbudgeting-bank.michael-matusik-jr.workers.dev";
const GIS_SRC = "https://accounts.google.com/gsi/client";
const listeners = new Set();

export function onAccountChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const changed = () => listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });

export class ApiError extends Error { constructor(status, message, data) { super(message); this.status = status; this.data = data; this.code = data?.code || null; } }

/** "Message (CODE)": the short reason code helps tell what went wrong when someone reports an error. */
export const withCode = (message, code) => code && !String(message).includes(`(${code})`) ? `${message} (${code})` : String(message);

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
  } catch { throw new ApiError(0, navigator.onLine ? "Can’t reach the sync server (NETWORK)" : "You’re offline (OFFLINE)", { code: navigator.onLine ? "NETWORK" : "OFFLINE" }); }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (auth && (res.status === 401 || data?.code === "REMOVED")) await markSignedOut(data?.error);
    const code = data?.code || (data?.error ? null : `HTTP_${res.status}`);
    throw new ApiError(res.status, withCode(data?.error || `Server error ${res.status}`, code), data);
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

/* ---------- invite links ---------- */

export const APP_LINK = "https://michaelmatusikjr.github.io/ToozBudgeting/";
const INVITE_RE = /^i_[\w-]{8,40}$/;

/** The invite from a ?invite= link this device opened, until sign-in uses it. */
export async function pendingInvite() { const v = await deviceGet("pendingInvite"); return INVITE_RE.test(String(v?.id || "")) ? v : null; }
export async function setPendingInvite(id) { await deviceSet("pendingInvite", id && INVITE_RE.test(id) ? { id, at: Date.now() } : null); }
export const isInviteId = (id) => INVITE_RE.test(String(id || ""));

/** Who invited you and to what (no sign-in needed). The email comes back masked. */
export const inviteDetails = (id) => api("GET", `/auth/invite/${encodeURIComponent(id)}`, undefined, { auth: false });

export const inviteLink = (id) => `${APP_LINK}?invite=${encodeURIComponent(id)}`;

export function inviteMessage(inv, householdName) {
  const where = householdName ? `our ToozBudgeting household (${householdName})` : "our ToozBudgeting household";
  return `Join ${where}:\n${inviteLink(inv.id)}\nSign in with Google using ${inv.email}.`;
}

/**
 * Share an invite with the phone's share sheet, or copy it when sharing isn't available.
 * Returns "shared", "copied", "canceled", or "manual" (the caller shows the text to copy by hand).
 */
export async function shareInvite(inv, householdName) {
  const text = inviteMessage(inv, householdName);
  if (navigator.share) {
    try { await navigator.share({ title: "Join our ToozBudgeting household", text }); return "shared"; }
    catch (e) { if (e?.name === "AbortError") return "canceled"; }
  }
  try { await navigator.clipboard.writeText(text); return "copied"; }
  catch { return "manual"; }
}

async function finishSignIn(res) {
  await setPendingInvite(null);
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
  const invite = (await pendingInvite())?.id;
  const res = await api("POST", "/auth/google", { credential, deviceName: deviceName(), ...(invite ? { invite } : {}) }, { auth: false });
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
 * The installed iPhone app can't get a popup back, and Google's button script in redirect mode depends on its own
 * page state. So there we use a plain link: the Worker sends the app to Google's sign-in page, Google posts the
 * ID token back to the Worker, and the Worker returns to the app with #signin=<one-time code>.
 */
function redirectButton(host, startUrl) {
  const a = document.createElement("a");
  a.className = "gsi-link";
  a.href = startUrl;
  a.setAttribute("role", "button");
  a.innerHTML = '<svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg><span>Sign in with Google</span>';
  host.replaceChildren(a);
  return true;
}

/**
 * Put the Sign in with Google button in host. onSignedIn(account) runs after the server accepts it.
 * Errors come back to onError as "Message (CODE)".
 */
export async function renderGoogleButton(host, { onSignedIn, onError } = {}) {
  const cfg = await authConfig();
  if (!cfg.ready) {
    host.replaceChildren(Object.assign(document.createElement("p"), { className: "hint", textContent: cfg.error ? `${cfg.error}. Sign-in will show here when it’s back.` : "Google sign-in isn’t set up on the server yet." }));
    return false;
  }
  if (isStandaloneIOS()) {
    const invite = (await pendingInvite())?.id;
    return redirectButton(host, (await serverUrl()) + "/auth/google/start" + (invite ? `?invite=${encodeURIComponent(invite)}` : ""));
  }
  let google;
  try { google = await loadGis(); }
  catch (e) { onError?.(withCode(e.message, "GSI_LOAD")); return false; }
  google.accounts.id.initialize({
    client_id: cfg.googleClientId,
    auto_select: false,
    cancel_on_tap_outside: true,
    ux_mode: "popup",
    callback: async (resp) => {
      if (!resp?.credential) { onError?.(withCode("Google didn’t send a sign-in. Try again.", "NO_CREDENTIAL")); return; }
      let acct;
      try { acct = await signInWithCredential(resp.credential); }
      catch (e) { onError?.(withCode(e.message, e.code || "ERROR")); return; }
      try { await onSignedIn?.(acct); }
      catch (e) { onError?.(withCode(`Signed in, but setting up this device failed: ${e.message}`, "AFTER_SIGNIN")); }
    },
  });
  host.replaceChildren();
  const width = Math.min(360, Math.max(220, host.clientWidth || 320));
  google.accounts.id.renderButton(host, { type: "standard", theme: "outline", size: "large", text: "signin_with", shape: "pill", logo_alignment: "left", width });
  return true;
}
