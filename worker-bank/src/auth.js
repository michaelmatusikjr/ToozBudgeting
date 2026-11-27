/**
 * Household accounts: Sign in with Google, sessions, households, members, and invites.
 *
 * The app sends Google's ID token. We check it against Google's published keys (RS256, aud = GOOGLE_CLIENT_ID,
 * iss = accounts.google.com, not expired, verified email), then issue our own session token. The server keeps
 * only a hash of it. Nobody joins a household without an invite, except emails in ALLOWED_OWNER_EMAILS.
 */
import { randomToken, sha256Hex, safeEqual, verifyRs256, jwtHeader, sealToken, openToken } from "./crypto.js";
import { HttpError, now, readJson, meta, setMeta } from "./http.js";
import { ROLES, BUDGET_ROLES, can, parseScopes, legacyRole, budgetRole, householdRole } from "./roles.js";

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
    const at = now();
    const grantRole = householdRoleFromInvite(inv.role);
    const grants = parseBudgetRoles(inv.budget_roles, { loose: true });
    const stmts = [
      env.DB.prepare("INSERT INTO memberships (household_id, user_id, role, scopes, display_name, access_rev, created_at, invited_by) VALUES (?, ?, ?, ?, ?, 1, ?, ?)")
        .bind(inv.household_id, user.id, grantRole, inv.scopes, user.name, at, inv.invited_by),
      env.DB.prepare("UPDATE invites SET accepted_at = ?, accepted_by = ? WHERE id = ?").bind(at, user.id, inv.id),
    ];
    for (const [budgetId, role] of Object.entries(grants)) {
      stmts.push(env.DB.prepare(
        "INSERT OR REPLACE INTO budget_access (household_id, budget_id, user_id, role, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(inv.household_id, budgetId, user.id, role, inv.invited_by, at));
    }
    await env.DB.batch(stmts);
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

function appUrl(env) {
  return String(env.APP_URL || "https://michaelmatusikjr.github.io/ToozBudgeting/");
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
  if (!id) return Response.redirect(appUrl(env) + "#signin-error=" + encodeURIComponent("Google sign-in isn’t set up on the server yet") + "&signin-code=NOT_CONFIGURED", 303);
  const nonce = randomToken(16);
  const invite = cleanInviteId(new URL(req.url).searchParams.get("invite"));
  const state = await sealToken(env.TOKEN_ENC_KEY, "oidc-state", JSON.stringify({ nonce, exp: now() + STATE_MS, ...(invite ? { invite } : {}) }));
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
  const back = (frag) => Response.redirect(appUrl(env) + "#" + frag, 303);
  let fields = null;
  try {
    let form;
    try { form = await req.formData(); }
    catch { throw fail(400, "BAD_FORM", "Google’s reply couldn’t be read. Try again."); }
    fields = [...new Set([...form.keys()])].slice(0, 12).join(",");
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
      m.role, m.display_name, m.access_rev
    FROM sessions s JOIN users u ON u.id = s.user_id
    LEFT JOIN memberships m ON m.household_id = s.household_id AND m.user_id = s.user_id
    WHERE s.id = ?`).bind(m[1]).first();
  if (!row || !(await safeEqual(row.token_hash, await sha256Hex(m[2])))) throw new HttpError(401, "You’re signed out. Sign in again.", { code: "SIGNED_OUT" });
  if (row.expires_at < now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(row.session_id).run();
    throw new HttpError(401, "Your sign-in expired. Sign in again.", { code: "SIGNED_OUT" });
  }
  if (!row.role) throw new HttpError(403, "You’re no longer in this household.", { code: "REMOVED" });
  const accessRows = (await env.DB.prepare(
    "SELECT budget_id, role FROM budget_access WHERE household_id = ? AND user_id = ?"
  ).bind(row.household_id, row.user_id).all()).results || [];
  const access = Object.fromEntries(accessRows.map((r) => [r.budget_id, r.role]));
  const household = row.role === "owner" ? "owner" : "member";
  const session = {
    sessionId: row.session_id,
    householdId: row.household_id,
    deviceName: row.device_name,
    user: { id: row.user_id, email: row.email, name: row.name, picture: row.picture },
    access,
    member: { householdRole: household, access, displayName: row.display_name || row.name, accessRev: row.access_rev || 1 },
    lastSeen: row.last_seen,
  };
  session.member.role = legacyRole(session);
  return session;
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
  return {
    id: row.id, email: row.email, role: householdRoleFromInvite(row.role), householdRole: householdRoleFromInvite(row.role),
    budgetRoles: parseBudgetRoles(row.budget_roles, { loose: true }),
    scopes: parseScopes(row.scopes), createdAt: row.created_at, expiresAt: row.expires_at, invitedBy: row.invited_by || null,
  };
}

export async function meView(env, session) {
  const hh = await env.DB.prepare("SELECT id, name, seq FROM households WHERE id = ?").bind(session.householdId).first();
  const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM records WHERE household_id = ? AND deleted = 0").bind(session.householdId).first())?.n || 0;
  return {
    user: { ...session.user, displayName: session.member.displayName },
    household: { id: hh?.id, name: hh?.name, seq: hh?.seq || 0, records: count },
    role: session.member.role,
    householdRole: session.member.householdRole,
    access: session.access || {},
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


/** Household roles are owner or member. A leftover "viewer" invite is stored as member. */
export function householdRoleFromInvite(role) {
  if (role === "owner") return "owner";
  return "member";
}

function checkHouseholdRole(role) {
  const r = String(role || "member");
  if (r === "admin") throw new HttpError(400, "Household role must be owner or member");
  if (r === "viewer") return "member";
  if (r !== "owner" && r !== "member") throw new HttpError(400, "Household role must be owner or member");
  return r;
}

function parseBudgetRoles(raw, { loose = false } = {}) {
  if (!raw) return {};
  let s = raw;
  if (typeof raw === "string") { try { s = JSON.parse(raw); } catch { if (loose) return {}; throw new HttpError(400, "budgetRoles must be an object"); } }
  if (!s || typeof s !== "object" || Array.isArray(s)) {
    if (loose) return {};
    throw new HttpError(400, "budgetRoles must be an object");
  }
  const out = {};
  for (const [id, role] of Object.entries(s)) {
    if (role == null || role === "" || role === "none") continue;
    const r = String(role) === "view only" ? "viewer" : String(role);
    if (!BUDGET_ROLES.includes(r)) throw new HttpError(400, "Budget role must be owner, member, or view only");
    out[String(id)] = r;
  }
  return out;
}

async function writeHouseholdLog(env, session, { action, targetUser = null, budgetId = null, before = null, after = null }) {
  await env.DB.prepare(
    "INSERT INTO household_log (household_id, at, user_id, action, target_user, budget_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(session.householdId, now(), session.user.id, action, targetUser, budgetId,
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after)).run();
}

export async function createInvite(env, req, session) {
  requireAction(session, "household.manage", "Only an owner can invite people");
  const body = await readJson(req);
  const email = lc(body.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Enter a valid email");
  const role = checkHouseholdRole(body.householdRole || body.role || "member");
  const budgetRoles = parseBudgetRoles(body.budgetRoles || body.budget_roles);
  for (const budgetId of Object.keys(budgetRoles)) {
    if (budgetRole(session, budgetId) !== "owner") {
      throw new HttpError(403, "You can only grant access to budgets you own", { code: "FORBIDDEN" });
    }
  }
  const already = await env.DB.prepare("SELECT 1 AS x FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.household_id = ? AND u.email = ?").bind(session.householdId, email).first();
  if (already) throw new HttpError(409, "That person is already in the household. Change their role instead.");
  const id = "i_" + randomToken(10);
  const at = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE invites SET revoked_at = ? WHERE household_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL").bind(at, session.householdId, email),
    env.DB.prepare("INSERT INTO invites (id, household_id, email, role, scopes, budget_roles, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, session.householdId, email, role, null, Object.keys(budgetRoles).length ? JSON.stringify(budgetRoles) : null, session.user.id, at, at + INVITE_DAYS * 86400000),
  ]);
  await writeHouseholdLog(env, session, { action: "invite.create", targetUser: email, after: { role, budgetRoles } });
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
  const requested = body.householdRole !== undefined ? body.householdRole : body.role;
  const role = requested === undefined ? (row.role === "owner" ? "owner" : "member") : checkHouseholdRole(requested);
  if (userId === session.user.id && row.role !== "owner" && role === "owner") {
    throw new HttpError(403, "A member can’t raise their own role", { code: "FORBIDDEN" });
  }
  if (row.role === "owner" && role !== "owner" && (await ownerCount(env, session.householdId)) <= 1) throw new HttpError(409, "The household needs at least one owner");
  const name = body.displayName === undefined ? row.display_name : String(body.displayName || "").trim().slice(0, 60) || row.display_name;
  await env.DB.prepare("UPDATE memberships SET role = ?, display_name = ?, access_rev = access_rev + 1 WHERE household_id = ? AND user_id = ?")
    .bind(role, name, session.householdId, userId).run();
  if (role !== row.role) await writeHouseholdLog(env, session, { action: "member.role", targetUser: userId, before: { role: row.role }, after: { role } });
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
    env.DB.prepare("DELETE FROM budget_access WHERE household_id = ? AND user_id = ?").bind(session.householdId, userId),
  ]);
  await writeHouseholdLog(env, session, { action: "member.remove", targetUser: userId, before: { role: row.role } });
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


/* ---------- per-budget access (WU-43) ---------- */

async function liveBudget(env, householdId, id) {
  const key = String(id || "");
  if (!key) return null;
  const row = await env.DB.prepare(
    "SELECT id, budget_id, body FROM records WHERE household_id = ? AND kind = 'budget' AND deleted = 0 AND (id = ? OR budget_id = ? OR id = ?)"
  ).bind(householdId, key, key, "budget:" + key).first();
  if (!row) return null;
  let name = key;
  try { name = JSON.parse(row.body || "null")?.name || row.budget_id || key; } catch { /* keep */ }
  return { id: row.budget_id || (String(row.id).startsWith("budget:") ? row.id.slice(7) : row.id), name };
}

function unknownBudget() {
  return new HttpError(404, "Not found", { code: "NOT_FOUND" });
}

function mayManageBudgetAccess(session, budgetId) {
  return budgetRole(session, budgetId) === "owner";
}

export async function listBudgetAccess(env, session, budgetId) {
  const budget = await liveBudget(env, session.householdId, budgetId);
  if (!budget) throw unknownBudget();
  if (!mayManageBudgetAccess(session, budget.id)) throw unknownBudget();
  const members = (await env.DB.prepare(`SELECT m.user_id, m.role AS household_role, m.display_name, u.email, u.name
    FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.household_id = ? ORDER BY m.created_at`)
    .bind(session.householdId).all()).results || [];
  const rows = (await env.DB.prepare("SELECT user_id, role FROM budget_access WHERE household_id = ? AND budget_id = ?")
    .bind(session.householdId, budget.id).all()).results || [];
  const map = Object.fromEntries(rows.map((r) => [r.user_id, r.role]));
  return {
    budget: { id: budget.id, name: budget.name },
    members: members.map((m) => {
      const household = m.household_role === "owner" ? "owner" : "member";
      const locked = household === "owner";
      const role = locked ? "owner" : (map[m.user_id] || null);
      return {
        userId: m.user_id,
        email: m.email,
        name: m.display_name || m.name,
        householdRole: household,
        role,
        locked,
      };
    }),
  };
}

export async function setBudgetAccess(env, req, session, budgetId) {
  const budget = await liveBudget(env, session.householdId, budgetId);
  if (!budget) throw unknownBudget();
  if (!mayManageBudgetAccess(session, budget.id)) throw unknownBudget();
  const body = await readJson(req);
  const incoming = body.access && typeof body.access === "object" ? body.access
    : Object.fromEntries((Array.isArray(body.members) ? body.members : []).map((m) => [m.userId, m.role]));
  const current = await listBudgetAccess(env, session, budget.id);
  const byId = Object.fromEntries(current.members.map((m) => [m.userId, m]));
  const at = now();
  const stmts = [];
  const changed = [];
  for (const [userId, raw] of Object.entries(incoming)) {
    const person = byId[userId];
    if (!person) throw new HttpError(404, "That person isn’t in the household");
    if (person.locked) continue;
    const next = (raw == null || raw === "" || raw === "none") ? null
      : (String(raw) === "view only" ? "viewer" : String(raw));
    if (next != null && !BUDGET_ROLES.includes(next)) throw new HttpError(400, "Budget role must be owner, member, view only, or no access");
    if ((person.role || null) === next) continue;
    changed.push({ userId, before: person.role, after: next });
    if (next == null) {
      stmts.push(env.DB.prepare("DELETE FROM budget_access WHERE household_id = ? AND budget_id = ? AND user_id = ?")
        .bind(session.householdId, budget.id, userId));
    } else {
      stmts.push(env.DB.prepare("INSERT OR REPLACE INTO budget_access (household_id, budget_id, user_id, role, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(session.householdId, budget.id, userId, next, session.user.id, at));
    }
    stmts.push(env.DB.prepare("UPDATE memberships SET access_rev = access_rev + 1 WHERE household_id = ? AND user_id = ?")
      .bind(session.householdId, userId));
  }
  // Every budget keeps at least one Owner (household Owners count).
  const nextMap = Object.fromEntries(current.members.map((m) => [m.userId, m.role]));
  for (const c of changed) nextMap[c.userId] = c.after;
  const hasOwner = current.members.some((m) => m.householdRole === "owner" || nextMap[m.userId] === "owner");
  if (!hasOwner) throw new HttpError(409, "This budget needs at least one owner");
  if (stmts.length) await env.DB.batch(stmts);
  for (const c of changed) {
    await writeHouseholdLog(env, session, { action: "budget.access", targetUser: c.userId, budgetId: budget.id, before: { role: c.before }, after: { role: c.after } });
  }
  return listBudgetAccess(env, session, budget.id);
}
