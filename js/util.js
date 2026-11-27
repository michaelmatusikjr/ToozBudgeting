/** Shared helpers. No DOM. Dates are local calendar dates (YYYY-MM-DD), never UTC slices. */

export const APP_NAME = "ToozBudgeting";
export const APP_VERSION = "1.5.3";
export const SCHEMA_VERSION = 1;

export const uid = () => {
  const b = new Uint8Array(8);
  if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(b);
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  const rand = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `id-${Date.now().toString(36)}-${rand}`;
};

export const genUserId = () => {
  const b = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(b);
  else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export const guestSuffix = (id) => String(id).replace(/-/g, "").toUpperCase().slice(0, 4);

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const fmt = (v) => {
  const n = Number(v) || 0;
  const a = Math.abs(n);
  const s = a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 && a >= 0.005 ? `−$${s}` : `$${s}`;
};

export const fmtPlain = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const toTitleCase = (s) => (s || "").replace(/\b\w/g, (c) => c.toUpperCase());

export const normalizeSearch = (s) => (s || "").toLowerCase().replace(/[^a-z0-9# ]/g, "").replace(/\s+/g, " ").trim();
export const normalizeMerge = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

const pad = (n) => String(n).padStart(2, "0");

export const todayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const monthKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

export const prevMonth = (k) => {
  const [y, m] = k.split("-").map(Number);
  return monthKey(new Date(y, m - 2, 1));
};
export const nextMonth = (k) => {
  const [y, m] = k.split("-").map(Number);
  return monthKey(new Date(y, m, 1));
};
export const monthLabel = (k) => {
  const [y, m] = k.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
};
export const monthLabelShort = (k) => {
  const [y, m] = k.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
};
export const monthRange = (k) => {
  const [y, m] = k.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${k}-01`, to: `${k}-${pad(last)}` };
};
export const cmpMonth = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const dateDiffDays = (a, b) => Math.abs((new Date(a + "T00:00:00").getTime() - new Date(b + "T00:00:00").getTime()) / 86400000);
export const daysSince = (dateStr) => Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(dateStr + "T00:00:00").getTime()) / 86400000);

export const addDays = (key, n) => {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return todayKey(dt);
};

/** Safe + − * / evaluator. Rejects anything that is not a number expression. */
export function evalMath(expr) {
  const str = String(expr ?? "").trim();
  if (!str) return 0;
  if (!/^[\d+\-*/().\s]+$/.test(str)) {
    const n = parseFloat(str.replace(/[$,]/g, ""));
    return Number.isFinite(n) ? round2(n) : 0;
  }
  let i = 0;
  const s = str.replace(/\s+/g, "");
  const peek = () => s[i];
  const num = () => {
    const start = i;
    if (s[i] === "+" || s[i] === "-") i++;
    let dot = false;
    let any = false;
    while (i < s.length && (/[0-9]/.test(s[i]) || (s[i] === "." && !dot))) {
      if (s[i] === ".") dot = true;
      any = true;
      i++;
    }
    if (!any) throw new Error("num");
    return parseFloat(s.slice(start, i));
  };
  function factor() {
    if (peek() === "(") {
      i++;
      const v = exprAdd();
      if (peek() !== ")") throw new Error("paren");
      i++;
      return v;
    }
    return num();
  }
  function term() {
    let v = factor();
    while (peek() === "*" || peek() === "/") {
      const op = s[i++];
      const r = factor();
      v = op === "*" ? v * r : r === 0 ? NaN : v / r;
    }
    return v;
  }
  function exprAdd() {
    let v = term();
    while (peek() === "+" || peek() === "-") {
      const op = s[i++];
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  try {
    const v = exprAdd();
    if (i !== s.length || typeof v !== "number" || !Number.isFinite(v)) throw new Error("bad");
    return round2(v);
  } catch {
    const n = parseFloat(str);
    return Number.isFinite(n) ? round2(n) : 0;
  }
}

export const hasOp = (s) => /[+\-*/]/.test(String(s).replace(/^\s*-?\s*/, ""));

export const moneyEq = (a, b, tol = 0.005) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < tol;

export const b64url = (bytes) => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const x of u8) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const b64urlToBytes = (s) => {
  const b = atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

export function randomDeviceId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return b64url(b);
}

export const timeZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
};

export const deepClone = (v) => {
  if (typeof structuredClone === "function") return structuredClone(v);
  return JSON.parse(JSON.stringify(v));
};

export const isCard = (budget, id) => (budget.creditCards || []).some((c) => c.id === id);
export const isBank = (budget, id) => (budget.accounts || []).some((a) => a.id === id);
export const findCat = (budget, id) => (budget.categories || []).find((c) => c.id === id);
export const ccPayCat = (budget, cardId) => (budget.categories || []).find((c) => c.creditCardId === cardId);

export const PAY_FROM = "__pay_from__";
export const isPayFrom = (v) => !!(v && String(v).startsWith(PAY_FROM));
export const payFromId = (v) => String(v || "").slice(PAY_FROM.length);
export const makePayFrom = (id) => PAY_FROM + id;
export const RTA = "__rta__";
