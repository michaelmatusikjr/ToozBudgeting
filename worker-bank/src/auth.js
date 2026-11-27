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

export async function verifyGoogleIdToken(env, fetchImpl, idToken) {
  const auds = clientIds(env);
  if (!auds.length) throw new HttpError(503, "Google sign-in isn’t set up on the server yet");
  let header;
  try { header = jwtHeader(idToken); } catch { throw new HttpError(401, "That sign-in didn’t look right. Try again."); }
  if (header.alg !== "RS256" || !header.kid) throw new HttpError(401, "That sign-in didn’t look right. Try again.");
  let keys = await googleKeys(env, fetchImpl);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await googleKeys(env, fetchImpl, true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw new HttpError(401, "Google’s sign-in key wasn’t recognized. Try again.");
  let p;
  try { p = await verifyRs256(idToken, jwk); } catch { throw new HttpError(401, "That sign-in couldn’t be verified"); }
  const t = Math.floor(now() / 1000);
  if (!GOOGLE_ISS.has(p.iss)) throw new HttpError(401, "That sign-in isn’t from Google");
  const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (!aud.some((a) => auds.includes(a))) throw new HttpError(401, "That sign-in was for a different app");
  if (!p.exp || p.exp < t - 60) throw new HttpError(401, "That sign-in expired. Try again.");
  if (p.iat && p.iat > t + 300) throw new HttpError(401, "That sign-in’s clock is off");
  if (!p.sub) throw new HttpError(401, "That sign-in has no account id");
  if (!p.email || !(p.email_verified === true || p.email_verified === "true")) throw new HttpError(403, "Your Google email isn’t verified");
  return { sub: String(p.sub), email: lc(p.email), name: String(p.name || p.given_name || p.email).slice(0, 80), picture: p.picture ? String(p.picture).slice(0, 500) : null };
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

async function signInWithCredential(env, req, fetchImpl, credential, deviceName) {
  const ip = await checkRate(env, req);
  let g;
  try { g = await verifyGoogleIdToken(env, fetchImpl, String(credential || "")); }
  catch (e) {
    if (e instanceof HttpError && e.status === 401) await env.DB.prepare("INSERT INTO attempts (ip, at) VALUES (?, ?)").bind(ip, now()).run();
    throw e;
  }
  const user = await upsertUser(env, g);
  const { membership, joined } = await resolveMembership(env, user);
  const token = await newSession(env, user, membership.household_id, deviceName);
  return { token, joined, user };
}

/** POST /auth/google { credential, deviceName } -> { token, me } */
export async function signInGoogle(env, req, fetchImpl) {
  const body = await readJson(req);
  const { token, joined } = await signInWithCredential(env, req, fetchImpl, body.credential, body.deviceName);
  const session = await sessionFromToken(env, token);
  return { token, joined, me: await meView(env, session) };
}

function appUrl(env) {
  return String(env.APP_URL || "https://michaelmatusikjr.github.io/ToozBudgeting/");
}

/**
 * POST /auth/google/redirect (form post from Google, used by the installed iPhone app where popups don't come back).
 * Signs in, then sends the browser back to the app with a one-time code it trades for the session token.
 */
export async function signInRedirect(env, req, fetchImpl) {
  const back = (frag) => Response.redirect(appUrl(env) + "#" + frag, 303);
  try {
    const form = await req.formData();
    const { token } = await signInWithCredential(env, req, fetchImpl, form.get("credential"), "Installed app");
    const code = randomToken(24);
    await env.DB.prepare("INSERT INTO login_codes (code_hash, sealed, expires_at) VALUES (?, ?, ?)")
      .bind(await sha256Hex(code), await sealToken(env.TOKEN_ENC_KEY, "login-code", token), now() + CODE_MS).run();
    return back("signin=" + code);
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : "Sign-in failed";
    return back("signin-error=" + encodeURIComponent(msg));
  }
}

/** POST /auth/redeem { code } -> { token, me } */
export async function redeemCode(env, req) {
  const body = await readJson(req);
  const hash = await sha256Hex(String(body.code || ""));
  const row = await env.DB.prepare("SELECT * FROM login_codes WHERE code_hash = ?").bind(hash).first();
  await env.DB.prepare("DELETE FROM login_codes WHERE code_hash = ? OR expires_at < ?").bind(hash, now()).run();
  if (!row || row.expires_at < now()) throw new HttpError(401, "That sign-in link expired. Sign in again.");
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
  return { id: row.id, email: row.email, role: row.role, scopes: parseScopes(row.scopes), createdAt: row.created_at, expiresAt: row.expires_at };
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
