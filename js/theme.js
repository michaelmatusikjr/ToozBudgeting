/** Named themes plus one custom palette. Device-only; never part of a budget export. */

export const THEMES = {
  standard: {
    id: "standard", name: "Standard", hint: "The default look",
    bg: "#f0eee9", surface: "#ffffff", ink: "#1a2035", accent: "#1a2b4a", band: "#eae7e1",
  },
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
  if (name === "standard" || name === "paper" || name === "ink" || name === "dusk" || name === "custom") return name;
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
  const good = dark ? "#8ed4ae" : "#1b7a4a";
  const navy = dark ? band : accent;
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
    "--good": good,
    "--good-soft": dark ? mix(bg, "#1b7a4a", 0.45) : "#e5f3eb",
    "--btn-shadow": dark ? "0 0 0 1px rgba(255,255,255,0.06)" : "0 1px 0 rgba(28,25,21,0.05), 0 1px 2px rgba(28,25,21,0.06)",
    "--card-shadow": dark ? "none" : "0 1px 2px rgba(28,25,21,0.05)",
    "--navy": navy,
    "--good-on-navy": mix(good, "#ffffff", 0.45),
    "--gold": mix(accent, dark ? "#f4eee6" : "#6a4a28", 0.35),
    "--purple": dark ? "#b3a1f5" : "#7B5EE8",
    "--amber": dark ? "#f5b14a" : "#F39C12",
    "--ink-2": mix(ink, bg, 0.25),
    "--input-bg": mix(surface, bg, 0.5),
    "--on-navy": dark ? ink : "#FFFFFF",
    "--group-bg": dark ? mix(surface, ink, 0.08) : "#EAE7E1",
    "--group-bg-reorder": dark ? mix(surface, "#b3a1f5", 0.22) : "#E4DDF5",
    "--row-reorder": dark ? mix(surface, "#b3a1f5", 0.12) : "#F3F0FA",
    "--row-divider": dark ? mix(surface, ink, 0.08) : "#F4F1EB",
    "--soft": dark ? mix(surface, ink, 0.06) : "#F8F6F2",
    "--green-bg": dark ? mix(surface, "#27AE60", 0.2) : "#EAF6F0",
    "--green-border": dark ? mix(surface, "#27AE60", 0.45) : "#A8DFBF",
    "--green-ink": dark ? good : "#1A5C36",
    "--amber-bg": dark ? mix(surface, "#F39C12", 0.2) : "#FFF8E7",
    "--amber-ink": dark ? "#f5b14a" : "#7A5800",
    "--red-bg": dark ? mix(surface, "#E74C3C", 0.22) : "#FDEDEC",
    "--zero": dark ? mix(ink, bg, 0.45) : "#C4C0CC",
    "--zero-group": dark ? mix(ink, bg, 0.38) : "#B5B0BD",
    "--rta-neg": "#FF6B6B",
    "--activity-neg-on-navy": "#FF9999",
    "--disabled": dark ? "#555" : "#ccc",
    "--scrim": "rgba(0,0,0,0.45)",
    "--scrim-light": "rgba(0,0,0,0.25)",
    "--scrim-select": "rgba(0,0,0,0.35)",
  };
  return { bg, surface, ink, accent, band, dark, vars };
}

const PROPS = [
  "--bg", "--bg-2", "--surface", "--ink", "--muted", "--line", "--band",
  "--accent", "--accent-ink", "--brass", "--brass-ink",
  "--danger", "--danger-soft", "--good", "--good-soft",
  "--btn-shadow", "--card-shadow",
  "--navy", "--good-on-navy", "--gold", "--purple", "--amber", "--ink-2", "--input-bg", "--on-navy",
  "--group-bg", "--group-bg-reorder", "--row-reorder", "--row-divider", "--soft",
  "--green-bg", "--green-border", "--green-ink", "--amber-bg", "--amber-ink", "--red-bg",
  "--zero", "--zero-group", "--rta-neg", "--activity-neg-on-navy", "--disabled",
  "--scrim", "--scrim-light", "--scrim-select",
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
    light.setAttribute("content", THEMES.standard.bg);
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
