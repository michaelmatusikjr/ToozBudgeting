import { test } from "node:test";
import assert from "node:assert/strict";
import { getTimeZone, setTimeZoneOverride, getTimeZoneOverride, deviceTimeZone, formatTime, listTimeZones } from "../js/time.js";

const instant = "2026-11-28T11:25:32.000Z"; // 5:25 AM in America/Chicago (CST)

test("getTimeZone uses the device zone when there is no override", () => {
  setTimeZoneOverride(null);
  assert.equal(getTimeZoneOverride(), null);
  assert.equal(getTimeZone(), deviceTimeZone());
  assert.ok(getTimeZone());
});

test("getTimeZone returns a manual override", () => {
  setTimeZoneOverride("America/New_York");
  assert.equal(getTimeZone(), "America/New_York");
  setTimeZoneOverride("");
  assert.equal(getTimeZoneOverride(), null);
  assert.equal(getTimeZone(), deviceTimeZone());
});

test("formatTime converts a UTC instant into the current time zone", () => {
  setTimeZoneOverride("America/Chicago");
  assert.equal(formatTime(instant), "Nov 28, 2026, 5:25 AM");
  setTimeZoneOverride("UTC");
  assert.equal(formatTime(instant), "Nov 28, 2026, 11:25 AM");
  setTimeZoneOverride("America/New_York");
  assert.equal(formatTime(instant), "Nov 28, 2026, 6:25 AM");
  setTimeZoneOverride("America/Los_Angeles");
  assert.equal(formatTime(instant), "Nov 28, 2026, 3:25 AM");
});

test("formatTime accepts Date objects and millisecond stamps, and leaves bad values blank", () => {
  setTimeZoneOverride("America/Chicago");
  assert.equal(formatTime(new Date(instant)), "Nov 28, 2026, 5:25 AM");
  assert.equal(formatTime(Date.parse(instant)), "Nov 28, 2026, 5:25 AM");
  assert.equal(formatTime(null), "");
  assert.equal(formatTime(""), "");
  assert.equal(formatTime("not a date"), "");
});

test("formatTime does not change the original UTC value", () => {
  setTimeZoneOverride("Pacific/Auckland");
  const d = new Date(instant);
  const iso = d.toISOString();
  formatTime(d);
  assert.equal(d.toISOString(), iso);
  assert.equal(iso, instant);
});

test("listTimeZones includes UTC and the device zone", () => {
  const list = listTimeZones();
  assert.ok(list.includes("UTC") || list.includes("Etc/UTC"));
  assert.ok(list.includes(deviceTimeZone()));
  assert.ok(list.length > 1);
});
