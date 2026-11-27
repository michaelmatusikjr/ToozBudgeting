/** Named themes plus one custom palette. Device-only; never part of a budget export. */

export const THEMES = {
  paper: {
    id: "paper", name: "Paper", hint: "Warm daylight",
    bg: "#f3efe6", surface: "#fffdf8", ink: "#1c1915", accent: "#1f6b56", band: "#e4d9c6",
  },
  ink: {
    id: "ink", name: "Ink", hint: "Warm night",
    bg: "#141210", surface: "#1c1916", ink: "#f4eee6", accent: "#8fcebb", band: "#322b24",
  },
  dusk: {
    id: "dusk", name: "Dusk", hint: "Cool copper",
    bg: "#0e141c", surface: "#15202b", ink: "#e8eef6", accent: "#e3a45c", band: "#243446",
  },
};

const CUSTOM_KEYS = ["bg", "surface", "ink", "accent"];

export function resolveTheme(name) {
  if (name === "light") return "paper";
  if (name === "dark") return "ink";
  if (name === "paper" || name === "ink" || name === "dusk" || name === "custom") return name;
  return "system";
}

function hex(v, fallback) {
  const s = String(v || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : fallback;
}

function rgb(h) {
  const n = h.slice(1);
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}

function hexOf(ch) {
  return `#${ch.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

function mix(a, b, t) {
  const pa = rgb(a);
  const pb = rgb(b);
  return hexOf(pa.map((v, i) => v + (pb[i] - v) * t));
}

function relLum(h) {
  const lin = (c) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(h);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function deriveCustom(input = {}) {
  const bg = hex(input.bg, THEMES.paper.bg);
  const surface = hex(input.surface, THEMES.paper.surface);
  const ink = hex(input.ink, THEMES.paper.ink);
  const accent = hex(input.accent, THEMES.paper.accent);
  const dark = relLum(bg) < 0.42;
  const band = mix(surface, ink, dark ? 0.16 : 0.07);
  const vars = {
    "--bg": bg,
    "--bg-2": mix(bg, ink, dark ? 0.1 : 0.06),
    "--surface": surface,
    "--ink": ink,
    "--muted": mix(ink, bg, 0.38),
    "--line": mix(bg, ink, dark ? 0.22 : 0.14),
    "--band": band,
    "--accent": accent,
    "--accent-ink": relLum(accent) > 0.4 ? "#1c1915" : "#f7f4ee",
    "--brass": mix(accent, dark ? "#f4eee6" : "#6a4a28", 0.35),
    "--brass-ink": dark ? "#1c1915" : "#3d3426",
    "--danger": dark ? "#f0a097" : "#a33b32",
    "--danger-soft": dark ? mix(bg, "#a33b32", 0.42) : "#f8e8e5",
    "--good": dark ? "#8ed4ae" : "#1b7a4a",
    "--good-soft": dark ? mix(bg, "#1b7a4a", 0.45) : "#e5f3eb",
    "--btn-shadow": dark ? "0 0 0 1px rgba(255,255,255,0.06)" : "0 1px 0 rgba(28,25,21,0.05), 0 1px 2px rgba(28,25,21,0.06)",
    "--card-shadow": dark ? "none" : "0 1px 2px rgba(28,25,21,0.05)",
  };
  return { bg, surface, ink, accent, band, dark, vars };
}

const PROPS = [
  "--bg", "--bg-2", "--surface", "--ink", "--muted", "--line", "--band",
  "--accent", "--accent-ink", "--brass", "--brass-ink",
  "--danger", "--danger-soft", "--good", "--good-soft",
  "--btn-shadow", "--card-shadow",
];

function clearProps(root) {
  for (const p of PROPS) root.style.removeProperty(p);
  root.style.removeProperty("color-scheme");
}

function paintMeta(color, system) {
  const metas = [...document.querySelectorAll('meta[name="theme-color"]')];
  if (!metas.length) return;
  if (system) {
    const light = metas[0];
    const dark = metas[1] || metas[0];
    light.setAttribute("media", "(prefers-color-scheme: light)");
    light.setAttribute("content", THEMES.paper.bg);
    if (dark !== light) {
      dark.setAttribute("media", "(prefers-color-scheme: dark)");
      dark.setAttribute("content", THEMES.ink.bg);
    }
    return;
  }
  for (const m of metas) {
    m.removeAttribute("media");
    m.setAttribute("content", color);
  }
}

export function paintTheme(name, custom) {
  const root = document.documentElement;
  const key = resolveTheme(name);
  if (key === "system") {
    root.removeAttribute("data-theme");
    clearProps(root);
    paintMeta(null, true);
    return;
  }
  if (key === "custom") {
    const d = deriveCustom(custom || {});
    root.dataset.theme = "custom";
    for (const [k, v] of Object.entries(d.vars)) root.style.setProperty(k, v);
    root.style.setProperty("color-scheme", d.dark ? "dark" : "light");
    paintMeta(d.bg, false);
    return;
  }
  root.dataset.theme = key;
  clearProps(root);
  paintMeta(THEMES[key].bg, false);
}

export function customFrom(input) {
  const d = deriveCustom(input);
  const out = {};
  for (const k of CUSTOM_KEYS) out[k] = d[k];
  return out;
}
