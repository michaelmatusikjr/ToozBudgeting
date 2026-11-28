/** Display helpers for UTC instants. Stored data stays UTC. */

let override = null;

export function setTimeZoneOverride(tz) {
  const next = String(tz || "").trim();
  override = next || null;
  return override;
}

export function getTimeZoneOverride() {
  return override;
}

export function deviceTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
}

/** Manual override, else the device's Intl time zone, else UTC. */
export function getTimeZone() {
  return override || deviceTimeZone() || "UTC";
}

export function listTimeZones() {
  let list = [];
  try {
    if (typeof Intl.supportedValuesOf === "function") list = [...Intl.supportedValuesOf("timeZone")];
  } catch { /* ignore */ }
  if (!list.length) {
    list = [
      "UTC", "America/Chicago", "America/New_York", "America/Denver", "America/Los_Angeles",
      "America/Anchorage", "Pacific/Honolulu", "Europe/London", "Europe/Paris", "Asia/Tokyo",
    ];
  }
  if (!list.includes("UTC") && !list.includes("Etc/UTC")) list = ["UTC", ...list];
  const device = deviceTimeZone();
  if (device && !list.includes(device)) list = [device, ...list];
  return list;
}

/**
 * Format a UTC instant in the current time zone.
 * `utc` may be an ISO string, a millisecond stamp, or a Date.
 */
export function formatTime(utc, opts = {}) {
  if (utc == null || utc === "") return "";
  const date = utc instanceof Date ? utc : new Date(utc);
  if (Number.isNaN(date.getTime())) return "";
  const defaults = {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
  return date.toLocaleString("en-US", { ...defaults, ...opts, timeZone: getTimeZone() });
}

/**
 * Resolve a time zone from the user's location. Call only after a user gesture.
 * Never throws; callers should still not block the UI on the returned promise.
 */
export function detectTimeZoneFromLocation() {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("This device can't share a location. Pick a time zone instead."));
      return;
    }
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const { latitude, longitude } = pos.coords;
        const url = `https://timeapi.io/api/timezone/coordinate?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error("bad response");
        const data = await res.json();
        const tz = data.timeZone || data.timezone || data.TimeZone;
        if (!tz || !String(tz).includes("/")) throw new Error("bad zone");
        resolve(String(tz));
      } catch {
        reject(new Error("Couldn't detect a time zone from your location. Pick one from the list."));
      }
    }, () => {
      reject(new Error("Location wasn't available. You can pick a time zone instead."));
    }, { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 });
  });
}
