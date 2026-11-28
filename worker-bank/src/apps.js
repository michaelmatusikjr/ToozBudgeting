/**
 * Other household apps that share this Worker's Google sign-in (one household, the same people and roles).
 *
 * Daily Tracker keeps its own end-to-end encrypted sync on its own Worker (daily-tracker-push). It can't take
 * a Google sign-in itself, so an owner "links" the household's Daily Tracker account here once: the app
 * stores the account's sign-in keys (username, the PBKDF2 authKey, and the key-encryption key that unwraps
 * the data key; never the password itself) sealed with TOKEN_ENC_KEY and bound to the household and app.
 * A signed-in owner or member then gets them back over their session and signs in to Daily Tracker with no
 * password. Viewers never get them: Daily Tracker's keys open every profile, so it can't be read-only.
 *
 * Each person can also keep small per-app preferences here (Daily Tracker: which profile is theirs).
 */
import { sealToken, openToken } from "./crypto.js";
import { HttpError, now, readJson } from "./http.js";
import { requireAction } from "./auth.js";

export const APPS = {
  "toozbudgeting": { name: "ToozBudgeting", path: "/ToozBudgeting/" },
  // GitHub Pages is case-sensitive: the repo is Daily-tracker, so /daily-tracker/ 404s.
  "daily-tracker": { name: "Daily Tracker", path: "/Daily-tracker/", link: true, linkRoles: ["owner", "member"] },
};

const PREFS_MAX = 4096;
const B64U_32 = /^[A-Za-z0-9_-]{43}$/;
const USERNAME = /^[a-z0-9._-]{3,40}$/;

export function appFor(id) {
  const a = APPS[String(id || "")];
  if (!a) throw new HttpError(404, "Unknown app");
  return a;
}

/** Where the redirect sign-in sends someone back: the app's page on the same site as APP_URL. */
export function appUrl(env, id) {
  const base = String(env.APP_URL || "https://michaelmatusikjr.github.io/ToozBudgeting/");
  const a = APPS[String(id || "")];
  if (!a || id === "toozbudgeting") return base;
  const env_key = "APP_URL_" + id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  if (env[env_key]) return String(env[env_key]);
  return new URL(a.path, base).href;
}

const aad = (householdId, id) => `app-link:${id}:${householdId}`;

function linkable(id) {
  const a = appFor(id);
  if (!a.link) throw new HttpError(404, "That app doesn’t use a linked account");
  return a;
}

function canUse(a, session) { return a.linkRoles.includes(session.member.role); }

/** GET /apps/:id  Linked or not, by whom, and whether this person can use it. Never the keys. */
export async function appStatus(env, session, id) {
  const a = linkable(id);
  const row = await env.DB.prepare(`SELECT l.label, l.updated_at, l.updated_by, COALESCE(m.display_name, u.name) AS by_name
    FROM app_links l LEFT JOIN users u ON u.id = l.updated_by LEFT JOIN memberships m ON m.user_id = l.updated_by AND m.household_id = l.household_id
    WHERE l.household_id = ? AND l.app = ?`).bind(session.householdId, id).first();
  return {
    app: id, name: a.name, linked: !!row, username: row?.label || null, updatedAt: row?.updated_at || null, updatedBy: row?.by_name || null,
    canUse: canUse(a, session), canManage: session.member.role === "owner", role: session.member.role,
  };
}

/** GET /apps/:id/keys  The linked account's sign-in keys, for owners and members. */
export async function appKeys(env, session, id) {
  const a = linkable(id);
  if (!canUse(a, session)) throw new HttpError(403, `View-only people can’t open ${a.name} with Google yet. Ask an owner to make you a member.`, { code: "FORBIDDEN" });
  const row = await env.DB.prepare("SELECT sealed FROM app_links WHERE household_id = ? AND app = ?").bind(session.householdId, id).first();
  if (!row) throw new HttpError(404, `${a.name} isn’t linked to your household yet. An owner links it once in ${a.name}’s Settings › Account.`, { code: "NOT_LINKED" });
  let keys;
  try { keys = JSON.parse(await openToken(env.TOKEN_ENC_KEY, aad(session.householdId, id), row.sealed)); }
  catch { throw new HttpError(409, "The saved link can’t be read. An owner needs to link it again.", { code: "LINK_BROKEN" }); }
  return { app: id, username: keys.username, authKey: keys.authKey, kek: keys.kek };
}

/** POST /apps/:id/link { username, authKey, kek }  Owners link (or re-link after a password change). */
export async function setAppLink(env, req, session, id) {
  const a = linkable(id);
  requireAction(session, "household.manage", `Only an owner can link ${a.name}`);
  const b = await readJson(req, 4096);
  const username = String(b.username || "").trim().toLowerCase();
  if (!USERNAME.test(username)) throw new HttpError(400, "username must be 3–40 of a-z 0-9 . _ -");
  if (!B64U_32.test(String(b.authKey || "")) || !B64U_32.test(String(b.kek || ""))) throw new HttpError(400, "authKey and kek must be 32 bytes, base64url");
  const sealed = await sealToken(env.TOKEN_ENC_KEY, aad(session.householdId, id), JSON.stringify({ v: 1, username, authKey: b.authKey, kek: b.kek }));
  await env.DB.prepare(`INSERT INTO app_links (household_id, app, sealed, label, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(household_id, app) DO UPDATE SET sealed = excluded.sealed, label = excluded.label, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind(session.householdId, id, sealed, username, session.user.id, now()).run();
  return appStatus(env, session, id);
}

/** DELETE /apps/:id/link  Owners unlink: nobody gets the keys any more (Daily Tracker itself is untouched). */
export async function removeAppLink(env, session, id) {
  const a = linkable(id);
  requireAction(session, "household.manage", `Only an owner can unlink ${a.name}`);
  await env.DB.prepare("DELETE FROM app_links WHERE household_id = ? AND app = ?").bind(session.householdId, id).run();
  return appStatus(env, session, id);
}

/** GET /apps/:id/prefs  This person's preferences for an app ({} when none). */
export async function getPrefs(env, session, id) {
  appFor(id);
  const row = await env.DB.prepare("SELECT prefs, updated_at FROM app_prefs WHERE household_id = ? AND user_id = ? AND app = ?").bind(session.householdId, session.user.id, id).first();
  let prefs = {};
  try { prefs = row ? JSON.parse(row.prefs) : {}; } catch { prefs = {}; }
  return { app: id, prefs, updatedAt: row?.updated_at || null };
}

/** POST /apps/:id/prefs { prefs }  Replace this person's preferences (a small JSON object). */
export async function setPrefs(env, req, session, id) {
  appFor(id);
  const b = await readJson(req, PREFS_MAX + 512);
  const p = b.prefs;
  if (!p || typeof p !== "object" || Array.isArray(p)) throw new HttpError(400, "prefs must be an object");
  const text = JSON.stringify(p);
  if (text.length > PREFS_MAX) throw new HttpError(413, "prefs are too large");
  await env.DB.prepare(`INSERT INTO app_prefs (household_id, user_id, app, prefs, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(household_id, user_id, app) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at`)
    .bind(session.householdId, session.user.id, id, text, now()).run();
  return getPrefs(env, session, id);
}
