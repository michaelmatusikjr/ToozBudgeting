/**
 * Household accounts: Sign in with Google, sessions, households, members, and invites.
 *
 * The app sends Google's ID token. We check it against Google's published keys (RS256, aud = GOOGLE_CLIENT_ID,
 * iss = accounts.google.com, not expired, verified email), then issue our own session token. The server keeps
 * only a hash of it. Nobody joins a household without an invite, except emails in ALLOWED_OWNER_EMAILS.
 */
import { randomToken, sha256Hex, safeEqual, verifyRs256, jwtHeader, sealToken, openToken } from "./crypto.js";
import { HttpError, now, readJson, meta, setMeta } from "./http.js";
import { ROLES, can, parseScopes } from "./roles.js";
import { appUrl as appUrlFor, APPS } from "./apps.js";

export const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const SESSION_DAYS = 180;
const INVITE_DAYS = 14;
const SIGNIN_FAILS_PER_HOUR = 20;
const MAX_SESSIONS_PER_USER = 20;
const CODE_MS = 2 * 60000;

const lc = (s) => String(s || "").trim().toLowerCase();
const clientIds = (env) => String(env.GOOGLE_CLIENT_ID || "").split(",").map((s) => s.trim()).filter(Boolean);
const ownerEmails = (env) => String(env.ALLOWED_OWNER_EMAILS || "").split(",").map(lc).filter(Boolean);
export const signInReady = (env) => clientIds(env).length > 0;
export const ownerEmailCount = (env) => ownerEmails(env).length;

/* ---------- Google ID tokens ---------- */

async function googleKeys(env, fetchImpl, force = false) {
  if (!force) {
    const cached = await meta(env, "google_jwks");
    if (cached) {
      try {
        const o = JSON.parse(cached);
        if (o.exp > now() && Array.isArray(o.keys)) return o.keys;
      } catch { /* refetch */ }
    }
  }
  const res = await fetchImpl(GOOGLE_CERTS_URL);
  if (!res.ok) throw new HttpError(502, "Couldn’t reach Google to check the sign-in");
  const data = await res.json();
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("Cache-Control") || "")?.[1] || 3600);
  const keys = Array.isArray(data.keys) ? data.keys : [];
  await setMeta(env, "google_jwks", JSON.stringify({ keys, exp: now() + Math.min(Math.max(maxAge, 300), 86400) * 1000 }));
  return keys;
}

/** A sign-in failure with a short reason code the app shows, e.g. "That sign-in expired. (EXPIRED)". */
const fail = (status, code, message) => new HttpError(status, message, { code });

export async function verifyGoogleIdToken(env, fetchImpl, idToken, { nonce = null } = {}) {
  const auds = clientIds(env);
  if (!auds.length) throw fail(503, "NOT_CONFIGURED", "Google sign-in isn’t set up on the server yet");
  if (!idToken) throw fail(401, "NO_CREDENTIAL", "Google didn’t send a sign-in. Try again.");
  let header;
  try { header = jwtHeader(idToken); } catch { throw fail(401, "BAD_TOKEN", "That sign-in didn’t look right. Try again."); }
  if (header.alg !== "RS256" || !header.kid) throw fail(401, "BAD_ALG", "That sign-in didn’t look right. Try again.");
  let keys;
  try { keys = await googleKeys(env, fetchImpl); } catch (e) { throw e instanceof HttpError ? fail(502, "JWKS_UNREACHABLE", e.message) : fail(502, "JWKS_UNREACHABLE", "Couldn’t reach Google to check the sign-in"); }
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await googleKeys(env, fetchImpl, true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw fail(401, "UNKNOWN_KEY", "Google’s sign-in key wasn’t recognized. Try again.");
  let p;
  try { p = await verifyRs256(idToken, jwk); } catch { throw fail(401, "BAD_SIGNATURE", "That sign-in couldn’t be verified"); }
  const t = Math.floor(now() / 1000);
  if (!GOOGLE_ISS.has(p.iss)) throw fail(401, "WRONG_ISSUER", "That sign-in isn’t from Google");
  const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (!aud.some((a) => auds.includes(a))) throw fail(401, "WRONG_AUDIENCE", "That sign-in was for a different app");
  if (!p.exp || p.exp < t - 60) throw fail(401, "EXPIRED", "That sign-in expired. Try again.");
  if (p.iat && p.iat > t + 300) throw fail(401, "CLOCK", "That sign-in’s clock is off");
  if (nonce !== null && !(await safeEqual(String(p.nonce || ""), nonce))) throw fail(401, "BAD_NONCE", "That sign-in didn’t match this request. Try again.");
  if (!p.sub) throw fail(401, "NO_SUB", "That sign-in has no account id");
  if (!p.email || !(p.email_verified === true || p.email_verified === "true")) throw fail(403, "EMAIL_UNVERIFIED", "Your Google email isn’t verified");
  return { sub: String(p.sub), email: lc(p.email), name: String(p.name || p.given_name || p.email).slice(0, 80), picture: p.picture ? String(p.picture).slice(0, 500) : null };
}

/** Remember the last sign-in failure (reason code and form field names only, never tokens) for /health and debugging. */
const noted = new WeakSet();
async function noteSignInFailure(env, info, err = null) {
  if (err && typeof err === "object") { if (noted.has(err)) return; noted.add(err); }
  try {
    console.log("signin_failure", JSON.stringify(info));
    await setMeta(env, "last_signin_error", JSON.stringify({ at: now(), ...info }));
  } catch { /* best effort */ }
}
export async function lastSignInError(env) {
  try { return JSON.parse((await meta(env, "last_signin_error")) || "null"); } catch { return null; }
}

/* ---------- invite links ---------- */

/** Invite ids look like i_<random>. Anything else is ignored. */
export const cleanInviteId = (v) => (/^i_[\w-]{8,40}$/.test(String(v || "")) ? String(v) : null);

/** "k•••@gmail.com": enough for the invitee to pick the right Google account, without exposing the address to anyone holding the link. */
export function maskEmail(email) {
  const [user, domain] = String(email || "").split("@");
  if (!domain) return "";
  return `${user.slice(0, 1)}${"•".repeat(Math.min(Math.max(user.length - 1, 3), 6))}@${domain}`;
}

async function inviteRow(env, id) {
  return env.DB.prepare(`SELECT i.*, h.name AS household_name, COALESCE(m.display_name, u.name, u.email) AS inviter_name, u.picture AS inviter_picture
    FROM invites i JOIN households h ON h.id = i.household_id
    LEFT JOIN users u ON u.id = i.invited_by
    LEFT JOIN memberships m ON m.user_id = i.invited_by AND m.household_id = i.household_id
    WHERE i.id = ?`).bind(id).first();
}

function inviteState(row) {
  if (!row) return "INVITE_NOT_FOUND";
  if (row.accepted_at) return "INVITE_USED";
  if (row.revoked_at) return "INVITE_REVOKED";
  if (row.expires_at < now()) return "INVITE_EXPIRED";
  return null;
}

const INVITE_MESSAGES = {
  INVITE_NOT_FOUND: "That invite link isn’t valid. Ask for a new one.",
  INVITE_USED: "That invite was already used. If it was yours, just sign in.",
  INVITE_REVOKED: "That invite was canceled. Ask for a new one.",
  INVITE_EXPIRED: "That invite expired. Ask for a new one.",
};

/** GET /auth/invite/<id> (no sign-in): who invited you and to what, so the app can show it before Google sign-in. */
export async function inviteInfo(env, id) {
  const clean = cleanInviteId(id);
  const row = clean ? await inviteRow(env, clean) : null;
  const bad = inviteState(row);
  if (bad) throw new HttpError(bad === "INVITE_NOT_FOUND" ? 404 : 410, INVITE_MESSAGES[bad], { code: bad });
  return {
    invite: {
      id: row.id, household: row.household_name || "a household", invitedBy: row.inviter_name || "A household owner",
      invitedByPicture: row.inviter_picture || null, role: row.role, emailHint: maskEmail(row.email), expiresAt: row.expires_at,
    },
  };
}

/** Signing in from an invite link with a different Google account gets a clear error instead of "not invited". */
async function checkInviteEmail(env, id, email) {
  const row = await inviteRow(env, id);
  if (inviteState(row)) return; // stale link: fall through to the normal checks (an existing member can still sign in)
  if (row.email !== email) {
    throw new HttpError(403, `This invite is for ${maskEmail(row.email)}. Sign in with that Google account.`, { code: "INVITE_EMAIL_MISMATCH", emailHint: maskEmail(row.email) });
  }
}

/* ---------- households and membership ---------- */

async function upsertUser(env, g) {
  const existing = await env.DB.prepare("SELECT * FROM users WHERE google_sub = ?").bind(g.sub).first();
  if (existing) {
    await env.DB.prepare("UPDATE users SET email = ?, name = ?, picture = ?, last_login = ? WHERE id = ?").bind(g.email, g.name, g.picture, now(), existing.id).run();
    return { ...existing, email: g.email, name: g.name, picture: g.picture };
  }
  const id = "u_" + randomToken(12);
  await env.DB.prepare("INSERT INTO users (id, google_sub, email, name, picture, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, g.sub, g.email, g.name, g.picture, now(), now()).run();
  return { id, google_sub: g.sub, email: g.email, name: g.name, picture: g.picture };
}

/**
 * Find or create this person's household membership:
 * 1. an existing membership,
 * 2. a pending invite for their email,
 * 3. an email in ALLOWED_OWNER_EMAILS: becomes an owner of the household (created on the very first sign-in).
 * Anyone else is refused.
 */
async function resolveMembership(env, user) {
  const mem = await env.DB.prepare("SELECT * FROM memberships WHERE user_id = ? ORDER BY created_at LIMIT 1").bind(user.id).first();
  if (mem) return { membership: mem, joined: null };
  const inv = await env.DB.prepare("SELECT * FROM invites WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1").bind(user.email, now()).first();
  if (inv) {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO memberships (household_id, user_id, role, scopes, display_name, access_rev, created_at, invited_by) VALUES (?, ?, ?, ?, ?, 1, ?, ?)")
        .bind(inv.household_id, user.id, inv.role, inv.scopes, user.name, now(), inv.invited_by),
      env.DB.prepare("UPDATE invites SET accepted_at = ?, accepted_by = ? WHERE id = ?").bind(now(), user.id, inv.id),
    ]);
    return { membership: await env.DB.prepare("SELECT * FROM memberships WHERE household_id = ? AND user_id = ?").bind(inv.household_id, user.id).first(), joined: "invite" };
  }
  if (ownerEmails(env).includes(user.email)) {
    let hh = await env.DB.prepare("SELECT id FROM households ORDER BY created_at LIMIT 1").first();
    let joined = "owner";
    if (!hh) {
      const id = "h_" + randomToken(12);
      await env.DB.prepare("INSERT INTO households (id, name, created_at, created_by, seq) VALUES (?, ?, ?, ?, 0)").bind(id, "Our household", now(), user.id).run();
      hh = { id };
      joined = "created";
    }
    await env.DB.prepare("INSERT INTO memberships (household_id, user_id, role, scopes, display_name, access_rev, created_at, invited_by) VALUES (?, ?, 'owner', NULL, ?, 1, ?, NULL)")
      .bind(hh.id, user.id, user.name, now()).run();
    return { membership: await env.DB.prepare("SELECT * FROM memberships WHERE household_id = ? AND user_id = ?").bind(hh.id, user.id).first(), joined };
  }
  throw new HttpError(403, "This Google account hasn’t been invited. Ask the household owner to invite your email in Settings.", { code: "NOT_INVITED" });
}

async function newSession(env, user, householdId, deviceName) {
  const id = "s_" + randomToken(12);
  const secret = randomToken(32);
  const old = (await env.DB.prepare("SELECT id FROM sessions WHERE user_id = ? ORDER BY last_seen DESC LIMIT -1 OFFSET ?").bind(user.id, MAX_SESSIONS_PER_USER - 1).all()).results || [];
  const stmts = old.map((r) => env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(r.id));
  stmts.push(env.DB.prepare("INSERT INTO sessions (id, token_hash, user_id, household_id, device_name, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, await sha256Hex(secret), user.id, householdId, String(deviceName || "Device").slice(0, 60), now(), now(), now() + SESSION_DAYS * 86400000));
  await env.DB.batch(stmts);
  return `${id}.${secret}`;
}

async function checkRate(env, req) {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const fails = (await env.DB.prepare("SELECT COUNT(*) AS n FROM attempts WHERE ip = ? AND at > ?").bind(ip, now() - 3600000).first())?.n || 0;
  if (fails >= SIGNIN_FAILS_PER_HOUR) throw new HttpError(429, "Too many sign-in tries. Wait an hour.");
  return ip;
}

async function signInWithCredential(env, req, fetchImpl, credential, deviceName, { nonce = null, via = "popup", fields = null, inviteId = null } = {}) {
  const ip = await checkRate(env, req);
  let g;
  try { g = await verifyGoogleIdToken(env, fetchImpl, String(credential || ""), { nonce }); }
  catch (e) {
    if (e instanceof HttpError && e.status === 401) await env.DB.prepare("INSERT INTO attempts (ip, at) VALUES (?, ?)").bind(ip, now()).run();
    await noteSignInFailure(env, { via, code: e?.extra?.code || "ERROR", fields, ua: uaFamily(req) }, e);
    throw e;
  }
  let res; let user;
  try {
    // An invite link only says which invite to expect. Access still comes from the Google email matching it.
    if (inviteId) await checkInviteEmail(env, inviteId, g.email);
    user = await upsertUser(env, g);
    res = await resolveMembership(env, user);
  }
  catch (e) { await noteSignInFailure(env, { via, code: e?.extra?.code || "ERROR", ua: uaFamily(req) }, e); throw e; }
  const token = await newSession(env, user, res.membership.household_id, deviceName);
  return { token, joined: res.joined, user };
}

function uaFamily(req) {
  const ua = req.headers.get("User-Agent") || "";
  const dev = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Other";
  const br = /CriOS|Chrome/.test(ua) ? "Chrome" : /FxiOS|Firefox/.test(ua) ? "Firefox" : /Safari/.test(ua) ? "Safari" : "WebView";
  return dev + " " + br;
}

/** POST /auth/google { credential, deviceName } -> { token, me } */
export async function signInGoogle(env, req, fetchImpl) {
  const body = await readJson(req);
  const { token, joined } = await signInWithCredential(env, req, fetchImpl, body.credential, body.deviceName, { inviteId: cleanInviteId(body.invite) });
  const session = await sessionFromToken(env, token);
  return { token, joined, me: await meView(env, session) };
}


const STATE_MS = 10 * 60000;

/** Where a redirect sign-in returns: ToozBudgeting, or another household app (src/apps.js) named at /auth/google/start?app=. */
function appUrl(env, app = null) {
  return app && APPS[app] ? appUrlFor(env, app) : String(env.APP_URL || "https://michaelmatusikjr.github.io/ToozBudgeting/");
}
function publicBase(env, req) {
  return String(env.PUBLIC_URL || new URL(req.url).origin).replace(/\/+$/, "");
}

/**
 * GET /auth/google/start: the installed iPhone app's sign-in. A plain top-level navigation to Google's OpenID Connect
 * page (response_type=id_token, response_mode=form_post), so it doesn't depend on the Sign in with Google script.
 * Google posts id_token + state back to /auth/google/redirect. The state is sealed with TOKEN_ENC_KEY and carries a
 * one-time nonce that the ID token has to repeat.
 */
export async function signInStart(env, req) {
  const id = clientIds(env)[0];
  const appParam = new URL(req.url).searchParams.get("app");
  const app = appParam && APPS[appParam] ? appParam : null;
  if (!id) return Response.redirect(appUrl(env, app) + "#signin-error=" + encodeURIComponent("Google sign-in isn’t set up on the server yet") + "&signin-code=NOT_CONFIGURED", 303);
  const nonce = randomToken(16);
  const invite = cleanInviteId(new URL(req.url).searchParams.get("invite"));
  const state = await sealToken(env.TOKEN_ENC_KEY, "oidc-state", JSON.stringify({ nonce, exp: now() + STATE_MS, ...(app ? { app } : {}), ...(invite ? { invite } : {}) }));
  const q = new URLSearchParams({
    client_id: id,
    redirect_uri: publicBase(env, req) + "/auth/google/redirect",
    response_type: "id_token",
    response_mode: "form_post",
    scope: "openid email profile",
    prompt: "select_account",
    nonce, state,
  });
  return Response.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + q, 303);
}

/**
 * POST /auth/google/redirect (form post from Google). Two senders:
 * - Google's OpenID page after /auth/google/start: id_token + state (nonce checked), or error=...
 * - the Sign in with Google button in redirect mode: credential (+ g_csrf_token).
 * Signs in, then sends the browser back to the app with a one-time code it trades for the session token.
 * Failures come back as #signin-error=<message>&signin-code=<CODE>.
 */
export async function signInRedirect(env, req, fetchImpl) {
  let target = appUrl(env);
  const back = (frag) => Response.redirect(target + "#" + frag, 303);
  let fields = null;
  try {
    let form;
    try { form = await req.formData(); }
    catch { throw fail(400, "BAD_FORM", "Google’s reply couldn’t be read. Try again."); }
    fields = [...new Set([...form.keys()])].slice(0, 12).join(",");
    // The sealed state names the app that started the sign-in (only apps in APPS; never a free URL).
    if (form.get("state")) {
      try { const peek = JSON.parse(await openToken(env.TOKEN_ENC_KEY, "oidc-state", String(form.get("state")))); if (peek?.app) target = appUrl(env, peek.app); } catch { /* checked below */ }
    }
    const err = form.get("error");
    if (err) throw fail(401, "GOOGLE_" + String(err).toUpperCase().replace(/[^A-Z_]/g, "").slice(0, 30), err === "access_denied" ? "Sign-in was canceled" : "Google couldn’t finish the sign-in. Try again.");
    const idToken = form.get("id_token");
    let nonce = null; let via = "gsi-redirect"; let inviteId = null;
    if (idToken || form.get("state")) {
      via = "oidc";
      let st = null;
      try { st = JSON.parse(await openToken(env.TOKEN_ENC_KEY, "oidc-state", String(form.get("state") || ""))); } catch { st = null; }
      if (!st || !st.nonce) throw fail(401, "BAD_STATE", "That sign-in link didn’t come from this app. Try again.");
      if (st.exp < now()) throw fail(401, "STATE_EXPIRED", "That sign-in took too long. Try again.");
      nonce = st.nonce;
      inviteId = cleanInviteId(st.invite);
    }
    const credential = idToken || form.get("credential");
    if (!credential) throw fail(401, "NO_CREDENTIAL", "Google didn’t send a sign-in. Try again.");
    const { token } = await signInWithCredential(env, req, fetchImpl, credential, "Installed app", { nonce, via, fields, inviteId });
    const code = randomToken(24);
    await env.DB.prepare("INSERT INTO login_codes (code_hash, sealed, expires_at) VALUES (?, ?, ?)")
      .bind(await sha256Hex(code), await sealToken(env.TOKEN_ENC_KEY, "login-code", token), now() + CODE_MS).run();
    return back("signin=" + code);
  } catch (e) {
    const code = e?.extra?.code || "ERROR";
    await noteSignInFailure(env, { via: "redirect", code, fields, ua: uaFamily(req) }, e);
    const msg = e instanceof HttpError ? e.message : "Sign-in failed";
    return back("signin-error=" + encodeURIComponent(msg) + "&signin-code=" + encodeURIComponent(code));
  }
}

/** POST /auth/redeem { code } -> { token, me } */
export async function redeemCode(env, req) {
  const body = await readJson(req);
  const hash = await sha256Hex(String(body.code || ""));
  const row = await env.DB.prepare("SELECT * FROM login_codes WHERE code_hash = ?").bind(hash).first();
  await env.DB.prepare("DELETE FROM login_codes WHERE code_hash = ? OR expires_at < ?").bind(hash, now()).run();
  if (!row || row.expires_at < now()) throw new HttpError(401, "That sign-in link expired. Sign in again.", { code: "CODE_EXPIRED" });
  const token = await openToken(env.TOKEN_ENC_KEY, "login-code", row.sealed);
  const session = await sessionFromToken(env, token);
  return { token, me: await meView(env, session) };
}

/* ---------- sessions ---------- */

async function sessionFromToken(env, token) {
  const m = /^(s_[\w-]+)\.([\w-]+)$/.exec(String(token || ""));
  if (!m) throw new HttpError(401, "Sign in first", { code: "SIGNED_OUT" });
  const row = await env.DB.prepare(`SELECT s.id AS session_id, s.token_hash, s.expires_at, s.last_seen, s.household_id, s.device_name,
      u.id AS user_id, u.email, u.name, u.picture,
      m.role, m.scopes, m.display_name, m.access_rev
    FROM sessions s JOIN users u ON u.id = s.user_id
    LEFT JOIN memberships m ON m.household_id = s.household_id AND m.user_id = s.user_id
    WHERE s.id = ?`).bind(m[1]).first();
  if (!row || !(await safeEqual(row.token_hash, await sha256Hex(m[2])))) throw new HttpError(401, "You’re signed out. Sign in again.", { code: "SIGNED_OUT" });
  if (row.expires_at < now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(row.session_id).run();
    throw new HttpError(401, "Your sign-in expired. Sign in again.", { code: "SIGNED_OUT" });
  }
  if (!row.role) throw new HttpError(403, "You’re no longer in this household.", { code: "REMOVED" });
  return {
    sessionId: row.session_id,
    householdId: row.household_id,
    deviceName: row.device_name,
    user: { id: row.user_id, email: row.email, name: row.name, picture: row.picture },
    member: { role: row.role, scopes: parseScopes(row.scopes), displayName: row.display_name || row.name, accessRev: row.access_rev || 1 },
    lastSeen: row.last_seen,
  };
}

/** Bearer session from the request. Refreshes last_seen and slides the expiry about once an hour. */
export async function authSession(env, req) {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.get("Authorization") || "");
  if (!m) throw new HttpError(401, "Sign in first", { code: "SIGNED_OUT" });
  const s = await sessionFromToken(env, m[1]);
  if (!s.lastSeen || now() - s.lastSeen > 3600000) {
    await env.DB.prepare("UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?").bind(now(), now() + SESSION_DAYS * 86400000, s.sessionId).run();
  }
  return s;
}

export function requireAction(session, action, message) {
  if (!can(session.member, action)) throw new HttpError(403, message || "You don’t have permission to do that", { code: "FORBIDDEN" });
}

export async function signOut(env, session, all = false) {
  if (all) await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(session.user.id).run();
  else await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(session.sessionId).run();
  return { ok: true };
}

/* ---------- me, members, invites ---------- */

function memberView(row) {
  return {
    userId: row.user_id, email: row.email, name: row.display_name || row.name, googleName: row.name, picture: row.picture,
    role: row.role, scopes: parseScopes(row.scopes), joinedAt: row.created_at,
  };
}

function inviteView(row) {
  return { id: row.id, email: row.email, role: row.role, scopes: parseScopes(row.scopes), createdAt: row.created_at, expiresAt: row.expires_at, invitedBy: row.invited_by || null };
}

export async function meView(env, session) {
  const hh = await env.DB.prepare("SELECT id, name, seq FROM households WHERE id = ?").bind(session.householdId).first();
  const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM records WHERE household_id = ? AND deleted = 0").bind(session.householdId).first())?.n || 0;
  return {
    user: { ...session.user, displayName: session.member.displayName },
    household: { id: hh?.id, name: hh?.name, seq: hh?.seq || 0, records: count },
    role: session.member.role,
    scopes: session.member.scopes,
    accessRev: session.member.accessRev,
    sessionId: session.sessionId,
  };
}

export async function updateMe(env, req, session) {
  const body = await readJson(req);
  const name = String(body.displayName || "").trim().slice(0, 60);
  if (!name) throw new HttpError(400, "Enter a name");
  await env.DB.prepare("UPDATE memberships SET display_name = ? WHERE household_id = ? AND user_id = ?").bind(name, session.householdId, session.user.id).run();
  session.member.displayName = name;
  return meView(env, session);
}

export async function listMembers(env, session) {
  requireAction(session, "household.read");
  const members = (await env.DB.prepare(`SELECT m.*, u.email, u.name, u.picture FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.household_id = ? ORDER BY m.created_at`).bind(session.householdId).all()).results || [];
  const out = { members: members.map(memberView), invites: [] };
  if (can(session.member, "household.manage")) {
    const inv = (await env.DB.prepare("SELECT * FROM invites WHERE household_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at")
      .bind(session.householdId, now()).all()).results || [];
    out.invites = inv.map(inviteView);
  }
  return out;
}

function checkRole(role) {
  if (!ROLES.includes(role)) throw new HttpError(400, "Role must be owner, member, or viewer");
  return role;
}

export async function createInvite(env, req, session) {
  requireAction(session, "household.manage", "Only an owner can invite people");
  const body = await readJson(req);
  const email = lc(body.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Enter a valid email");
  const role = checkRole(String(body.role || "member"));
  const scopes = parseScopes(body.scopes);
  const already = await env.DB.prepare("SELECT 1 AS x FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.household_id = ? AND u.email = ?").bind(session.householdId, email).first();
  if (already) throw new HttpError(409, "That person is already in the household. Change their role instead.");
  const id = "i_" + randomToken(10);
  await env.DB.batch([
    env.DB.prepare("UPDATE invites SET revoked_at = ? WHERE household_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL").bind(now(), session.householdId, email),
    env.DB.prepare("INSERT INTO invites (id, household_id, email, role, scopes, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, session.householdId, email, role, scopes ? JSON.stringify(scopes) : null, session.user.id, now(), now() + INVITE_DAYS * 86400000),
  ]);
  return { invite: inviteView(await env.DB.prepare("SELECT * FROM invites WHERE id = ?").bind(id).first()) };
}

export async function revokeInvite(env, session, id) {
  requireAction(session, "household.manage", "Only an owner can change invites");
  await env.DB.prepare("UPDATE invites SET revoked_at = ? WHERE id = ? AND household_id = ? AND accepted_at IS NULL").bind(now(), id, session.householdId).run();
  return { ok: true };
}

async function ownerCount(env, householdId) {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM memberships WHERE household_id = ? AND role = 'owner'").bind(householdId).first())?.n || 0;
}

export async function updateMember(env, req, session, userId) {
  requireAction(session, "household.manage", "Only an owner can change roles");
  const body = await readJson(req);
  const row = await env.DB.prepare("SELECT * FROM memberships WHERE household_id = ? AND user_id = ?").bind(session.householdId, userId).first();
  if (!row) throw new HttpError(404, "That person isn’t in the household");
  const role = body.role === undefined ? row.role : checkRole(String(body.role));
  if (row.role === "owner" && role !== "owner" && (await ownerCount(env, session.householdId)) <= 1) throw new HttpError(409, "The household needs at least one owner");
  const scopes = body.scopes === undefined ? row.scopes : (parseScopes(body.scopes) ? JSON.stringify(parseScopes(body.scopes)) : null);
  const name = body.displayName === undefined ? row.display_name : String(body.displayName || "").trim().slice(0, 60) || row.display_name;
  await env.DB.prepare("UPDATE memberships SET role = ?, scopes = ?, display_name = ?, access_rev = access_rev + 1 WHERE household_id = ? AND user_id = ?")
    .bind(role, scopes, name, session.householdId, userId).run();
  return listMembers(env, session);
}

export async function removeMember(env, session, userId) {
  const self = userId === session.user.id;
  if (!self) requireAction(session, "household.manage", "Only an owner can remove people");
  const row = await env.DB.prepare("SELECT * FROM memberships WHERE household_id = ? AND user_id = ?").bind(session.householdId, userId).first();
  if (!row) throw new HttpError(404, "That person isn’t in the household");
  if (row.role === "owner" && (await ownerCount(env, session.householdId)) <= 1) throw new HttpError(409, "The household needs at least one owner");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM memberships WHERE household_id = ? AND user_id = ?").bind(session.householdId, userId),
    env.DB.prepare("DELETE FROM sessions WHERE household_id = ? AND user_id = ?").bind(session.householdId, userId),
    env.DB.prepare("DELETE FROM app_prefs WHERE household_id = ? AND user_id = ?").bind(session.householdId, userId),
  ]);
  return self ? { ok: true } : listMembers(env, session);
}

export async function renameHousehold(env, req, session) {
  requireAction(session, "household.manage", "Only an owner can rename the household");
  const body = await readJson(req);
  const name = String(body.name || "").trim().slice(0, 60);
  if (!name) throw new HttpError(400, "Enter a name");
  await env.DB.prepare("UPDATE households SET name = ? WHERE id = ?").bind(name, session.householdId).run();
  return meView(env, session);
}
