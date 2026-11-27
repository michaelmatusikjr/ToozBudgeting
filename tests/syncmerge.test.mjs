import { test } from "node:test";
import assert from "node:assert/strict";
import { remoteWins, newer, SYNC_KINDS, cellId } from "../js/syncmerge.js?v=140";
import { SYNC_KINDS as SERVER_KINDS } from "../worker-bank/src/roles.js";

test("the app and the server agree on which records are shared", () => {
  assert.deepEqual([...SYNC_KINDS].sort(), [...SERVER_KINDS].sort());
  assert.ok(!SYNC_KINDS.has("app") && !SYNC_KINDS.has("user"), "device settings and local profiles never sync");
});

test("newer: later time wins, then the higher device id", () => {
  assert.equal(newer({ t: 2, dev: "a" }, { t: 1, dev: "z" }), true);
  assert.equal(newer({ t: 1, dev: "z" }, { t: 1, dev: "a" }), true);
  assert.equal(newer({ t: 1, dev: "a" }, { t: 1, dev: "a" }), false);
});

test("remoteWins: the server copy replaces anything not waiting to upload", () => {
  assert.equal(remoteWins(null, { t: 1, dev: "a" }), true);
  assert.equal(remoteWins({ t: 9, dev: "a", dirty: 0 }, { t: 1, dev: "b" }), true, "server is the truth for synced records");
});

test("remoteWins: a newer unsent local edit survives a pull, an older one loses", () => {
  assert.equal(remoteWins({ t: 5, dev: "me", dirty: 1 }, { t: 3, dev: "wife" }), false);
  assert.equal(remoteWins({ t: 3, dev: "me", dirty: 1 }, { t: 5, dev: "wife" }), true);
  assert.equal(remoteWins({ t: 5, dev: "me", dirty: 1 }, { t: 5, dev: "me" }), true, "our own edit echoed back");
});

test("assignment cells are one record per month and category", () => {
  assert.equal(cellId("b1", "2026-11", "cat-1"), "mbc:b1:2026-11:cat-1");
  assert.notEqual(cellId("b1", "2026-11", "cat-1"), cellId("b1", "2026-11", "cat-2"));
});
