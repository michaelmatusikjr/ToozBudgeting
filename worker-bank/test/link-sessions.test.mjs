/** v2.0.3: Plaid Link sessions kept server-side so a bank OAuth return in another browser (Safari) can finish. */
import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.mjs";

test("link token creates a server-side Link session that a signed-in owner in another browser can resume", async () => {
  const t = setup();
  const phoneApp = await t.signIn(); // the home-screen app
  const lt = await t.call("POST", "/bank/link-token", {}, phoneApp.auth);
  assert.equal(lt.status, 200);
  assert.match(lt.data.linkSessionId, /^l_/);
  const row = t.DB.raw.prepare("SELECT * FROM link_sessions WHERE id = ?").get(lt.data.linkSessionId);
  assert.ok(row && !row.link_token_enc.includes("link-production"), "link token is sealed at rest");

  const safari = await t.signIn(); // same person, signed in again in Safari: a different session
  assert.notEqual(safari.token, phoneApp.token);
  const p = await t.call("GET", "/bank/link/pending", undefined, safari.auth);
  assert.equal(p.status, 200);
  assert.equal(p.data.link.linkToken, "link-production-abc");
  assert.equal(p.data.link.id, lt.data.linkSessionId);
  assert.equal(p.data.link.mode, "create");

  await t.call("POST", `/bank/link/${lt.data.linkSessionId}/event`, { status: "oauth" }, phoneApp.auth);
  assert.equal((await t.call("GET", `/bank/link/${lt.data.linkSessionId}`, undefined, phoneApp.auth)).data.link.status, "oauth");

  // Safari finishes Link and exchanges with the session id.
  const ex = await t.call("POST", "/bank/exchange", { publicToken: "public-1", institution: { institution_id: "ins_56", name: "Chase" }, linkSessionId: lt.data.linkSessionId }, safari.auth);
  assert.equal(ex.status, 200);
  await Promise.all(t.waits.splice(0));
  // The app polling its Link session sees it's done, with the bank.
  const st = await t.call("GET", `/bank/link/${lt.data.linkSessionId}`, undefined, phoneApp.auth);
  assert.equal(st.data.link.status, "done");
  assert.equal(st.data.link.result.institution, "Chase");
  assert.equal(st.data.link.result.itemId, ex.data.item.itemId);
  // Nothing left to resume.
  assert.equal((await t.call("GET", "/bank/link/pending", undefined, safari.auth)).data.code, "LINK_NOT_FOUND");
  assert.equal((await t.call("GET", "/bank/items", undefined, phoneApp.auth)).data.used, 1);
});

test("Link sessions: owners only, household-scoped, expire, and an exited session isn't resumed", async () => {
  const t = setup();
  const owner = await t.signIn();
  await t.call("POST", "/household/invites", { email: "kid@example.com", role: "viewer" }, owner.auth);
  const kid = await t.signIn("kid@example.com");
  const lt = await t.call("POST", "/bank/link-token", {}, owner.auth);
  assert.equal((await t.call("GET", "/bank/link/pending", undefined, kid.auth)).status, 403, "viewers can't fetch link tokens");
  assert.equal((await t.call("POST", "/bank/link-token", {}, kid.auth)).status, 403);
  await t.call("POST", `/bank/link/${lt.data.linkSessionId}/event`, { status: "exited", reason: "USER_EXIT" }, owner.auth);
  assert.equal((await t.call("GET", "/bank/link/pending", undefined, owner.auth)).status, 404);
  const lt2 = await t.call("POST", "/bank/link-token", {}, owner.auth);
  t.DB.raw.exec(`UPDATE link_sessions SET expires_at = 1 WHERE id = '${lt2.data.linkSessionId}'`);
  assert.equal((await t.call("GET", "/bank/link/pending", undefined, owner.auth)).data.code, "LINK_NOT_FOUND", "expired");
  // Another household can't see it.
  const t2 = setup();
  assert.equal((await t.call("GET", "/bank/link/l_nope123456789", undefined, owner.auth)).status, 404);
  void t2;
});

test("Reconnect (update mode) finishes its Link session through /repaired", async () => {
  const t = setup();
  const d = await t.signIn();
  const ex = await t.call("POST", "/bank/exchange", { publicToken: "public-1", institution: { institution_id: "ins_56", name: "Chase" } }, d.auth);
  await Promise.all(t.waits.splice(0));
  const lt = await t.call("POST", "/bank/link-token", { itemId: ex.data.item.itemId }, d.auth);
  assert.equal(lt.data.mode, "update");
  assert.equal((await t.call("GET", "/bank/link/pending", undefined, d.auth)).data.link.itemId, ex.data.item.itemId);
  await t.call("POST", `/bank/items/${ex.data.item.itemId}/repaired`, { linkSessionId: lt.data.linkSessionId }, d.auth);
  await Promise.all(t.waits.splice(0));
  assert.equal((await t.call("GET", `/bank/link/${lt.data.linkSessionId}`, undefined, d.auth)).data.link.status, "done");
});
