/** DOM helpers, toasts, sheets, and the amount pad. User text always goes through textContent. */
export const devHooks = {}; // filled by js/dev/testtools.js when test tools are on
import { evalMath, fmt, hasOp, round2 } from "./util.js?v=154";

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let valueToSet;
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = String(v);
      else if (k === "html") el.innerHTML = v; // trusted static markup only
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "value") valueToSet = v;
      else if (k === "checked") el.checked = !!v;
      else if (k === "disabled") el.disabled = !!v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    if (typeof kid === "string" || typeof kid === "number") el.append(document.createTextNode(String(kid)));
    else el.append(kid);
  }
  if (valueToSet != null) el.value = valueToSet;
  return el;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

export function append(node, ...kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    if (typeof kid === "string" || typeof kid === "number") node.append(document.createTextNode(String(kid)));
    else node.append(kid);
  }
  return node;
}

const ICON_EMOJI = {
  budget: "📊", tx: "💸", accounts: "🏦", payees: "👥", settings: "⚙️",
  bell: "🔔", plus: "＋", undo: "↩", redo: "↪", check: "✅", close: "✕", chev: "▶",
};

export function icon(name) {
  if (ICON_EMOJI[name]) return h("span", { class: "ico-emoji", "aria-hidden": "true", text: ICON_EMOJI[name] });
  const paths = {
    budget: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    tx: '<path d="M4 7h16M4 12h16M4 17h10"/><path d="M15 15l3 3 3-3"/>',
    accounts: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/>',
    payees: '<circle cx="9" cy="9" r="3"/><path d="M4 19c.6-3 2.6-4.5 5-4.5S13.4 16 14 19"/><circle cx="16" cy="9" r="2.4"/><path d="M16 14.5c1.8 0 3.4 1 4 3"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/>',
    bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2H4.5L6 16z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    back: '<path d="M15 5 8 12l7 7"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-3.5-3.5"/>',
    check: '<path d="m5 12 5 5L20 7"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
  };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "ico");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = paths[name] || paths.budget;
  return svg;
}

const toastHost = () => document.getElementById("toasts");
let toastTimer = null;
export function toast(message, { action, label, ms = 4200 } = {}) {
  const host = toastHost();
  if (!host) return;
  clear(host);
  const el = h("div", { class: "toast", role: "status" }, h("span", { text: message }));
  if (action) el.append(h("button", { class: "toast-action", type: "button", text: label || "Undo", onclick: () => { action(); clear(host); } }));
  host.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (host.contains(el)) el.remove(); }, ms);
}

const stack = [];
function dismiss(scrim) {
  if (!scrim) return;
  const i = stack.indexOf(scrim);
  if (i >= 0) stack.splice(i, 1);
  const fn = scrim._onClose;
  scrim._onClose = null;
  scrim.remove();
  fn?.();
  if (!stack.length) document.body.classList.remove("modal-open");
}
export function closeModal() {
  dismiss(stack[stack.length - 1]);
}
export function closeAllModals() {
  while (stack.length) dismiss(stack[stack.length - 1]);
}

export function openSheet({ title, body, onClose, closeLabel, blocking = false }) {
  document.body.classList.add("modal-open");
  const scrim = h("div", { class: "scrim", onclick: (e) => { if (!blocking && e.target === scrim) dismiss(scrim); } });
  scrim._onClose = onClose;
  scrim._blocking = !!blocking;
  const sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true" });
  const closeBtn = blocking ? null : h("button", {
    class: "sheet-close", type: "button",
    "aria-label": closeLabel || "Close",
    onclick: () => dismiss(scrim),
    text: closeLabel || "✕",
  });
  const head = h("div", { class: "sheet-head" },
    h("h2", { class: "sheet-title", text: title || "" }),
    closeBtn,
  );
  const content = h("div", { class: "sheet-body" });
  if (typeof body === "function") body(content);
  else if (body) content.append(body);
  sheet.append(head, content);
  scrim.append(sheet);
  document.body.append(scrim);
  stack.push(scrim);
  (closeBtn || sheet.querySelector("button, input, select, textarea"))?.focus?.();
  return { content, close: () => dismiss(scrim), blocking: !!blocking };
}

export function btnRow(cancel, save) {
  const toBtn = (spec, fallback) => {
    if (spec instanceof Node) return spec;
    const o = spec || fallback;
    return btn(o.label || fallback.label, {
      kind: o.kind || fallback.kind,
      disabled: !!o.disabled,
      onClick: o.onClick,
    });
  };
  const cancelBtn = toBtn(cancel, { label: "Cancel", kind: "ghost" });
  const saveBtn = toBtn(save, { label: "Save", kind: "primary" });
  return h("div", { class: "btn-row" }, cancelBtn, saveBtn);
}

export function iconBtn(opts = {}) {
  const kids = opts.children == null ? [] : (Array.isArray(opts.children) ? opts.children : [opts.children]);
  if (opts.text != null) kids.push(h("span", { "aria-hidden": "true", text: opts.text }));
  return h("button", {
    type: "button",
    class: `ico-btn${opts.active ? " on" : ""}`,
    disabled: !!opts.disabled,
    "aria-label": opts.label || opts["aria-label"] || "",
    onclick: opts.onClick,
  }, ...kids);
}

export function confirmModal({ title, body, yes = "OK", no = "Cancel", danger = false, onYes, onNo } = {}) {
  return new Promise((resolve) => {
    const sheet = openSheet({
      title: title || "",
      body: (root) => {
        if (typeof body === "function") body(root);
        else if (body instanceof Node) root.append(body);
        else if (body) root.append(h("p", { class: "lede", text: String(body) }));
        root.append(btnRow(
          { label: no, kind: "ghost", onClick: () => { sheet.close(); onNo?.(); resolve(false); } },
          { label: yes, kind: danger ? "danger" : "primary", onClick: () => { sheet.close(); onYes?.(); resolve(true); } },
        ));
      },
    });
  });
}

export function field(label, control) {
  return h("label", { class: "field" }, h("span", { class: "field-label", text: label }), control);
}

export function textInput(opts = {}) {
  return h("input", { class: "input", type: opts.type || "text", placeholder: opts.placeholder || "", value: opts.value || "", autocomplete: opts.autocomplete || "off", inputmode: opts.inputmode || null });
}

export function btn(label, opts = {}) {
  return h("button", { class: `btn ${opts.kind || "primary"} ${opts.block ? "block" : ""}`, type: "button", disabled: !!opts.disabled, onclick: opts.onClick }, opts.icon ? icon(opts.icon) : null, h("span", { text: label }));
}

let padState = null;
export function openAmountPad({ title = "Amount", value = 0, onCommit, allowNegative = false }) {
  return openPad({ title, value, onCommit, allowNegative });
}

export function moneyButton(value, onCommit, { allowNegative = false, label } = {}) {
  const b = h("button", { type: "button", class: "money-btn", onclick: () => openAmountPad({ title: label || "Amount", value, allowNegative, onCommit: (n) => { b.textContent = fmt(n); b.dataset.value = String(n); onCommit(n); } }) });
  b.textContent = fmt(value || 0);
  b.dataset.value = String(value || 0);
  return b;
}

export function confirmDialog({ title, message, confirm = "Confirm", danger = false, onConfirm, extra }) {
  const sheet = openSheet({
    title,
    body: (root) => {
      root.append(h("p", { class: "lede", text: message }));
      extra?.(root, sheet);
      root.append(btnRow(
        { label: "Cancel", kind: "ghost", onClick: () => sheet.close() },
        { label: confirm, kind: danger ? "danger" : "primary", onClick: () => { sheet.close(); onConfirm?.(); } },
      ));
    },
  });
}

export function keepFocus(el) {
  queueMicrotask(() => {
    el?.focus?.({ preventScroll: true });
    try {
      const n = el.value?.length ?? 0;
      el.setSelectionRange(n, n);
    } catch { /* date and number inputs */ }
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !stack.length) return;
  const top = stack[stack.length - 1];
  if (top._blocking) { e.preventDefault(); return; }
  e.preventDefault();
  closeModal();
});

function bindKeyboard() {
  const apply = () => {
    const vv = window.visualViewport;
    const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    document.documentElement.style.setProperty("--kb", `${Math.round(kb)}px`);
  };
  apply();
  window.visualViewport?.addEventListener("resize", apply);
  window.visualViewport?.addEventListener("scroll", apply);
  window.addEventListener("resize", apply);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bindKeyboard);
else bindKeyboard();

/* ---------- WU-03 context menu + long-press ---------- */

export function isTouchUi() {
  return !!(navigator.maxTouchPoints > 0 || window.matchMedia?.("(pointer: coarse)")?.matches);
}

function suppressNextClick(el) {
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); el.removeEventListener("click", stop, true); };
  el.addEventListener("click", stop, true);
  setTimeout(() => el.removeEventListener("click", stop, true), 700);
}

export function openContextMenu(items = [], { readOnly = false } = {}) {
  const list = (items || []).filter((it) => it && !(readOnly && it.edit));
  const scrim = h("div", {
    class: "ctx-scrim",
    oncontextmenu: (e) => { e.preventDefault(); dismissCtx(); },
    onclick: (e) => { if (e.target === scrim) dismissCtx(); },
  });
  const menu = h("div", { class: "ctx-menu", role: "menu", onclick: (e) => e.stopPropagation() });
  for (const item of list) {
    menu.append(h("button", {
      type: "button",
      class: `ctx-item${item.danger ? " danger" : ""}`,
      role: "menuitem",
      disabled: !!item.disabled,
      onclick: () => { if (item.disabled) return; dismissCtx(); item.onClick?.(); },
      text: item.label,
    }));
  }
  menu.append(h("button", { type: "button", class: "ctx-cancel", text: "Cancel", onclick: () => dismissCtx() }));
  scrim.append(menu);
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); dismissCtx(); }
  };
  const dismissCtx = () => {
    window.removeEventListener("keydown", onKey, true);
    scrim.remove();
  };
  document.body.append(scrim);
  window.addEventListener("keydown", onKey, true);
  menu.querySelector("button:not([disabled])")?.focus?.();
  return { close: dismissCtx };
}

export function bindLongPress(el, fn, { ms = 500 } = {}) {
  let timer = null;
  let startX = 0, startY = 0;
  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const start = (x, y) => {
    clearTimer();
    startX = x; startY = y;
    timer = setTimeout(() => {
      timer = null;
      suppressNextClick(el);
      fn();
    }, ms);
  };
  el.addEventListener("touchstart", (e) => {
    const t = e.changedTouches[0];
    if (t) start(t.clientX, t.clientY);
  }, { passive: true });
  el.addEventListener("touchmove", (e) => {
    const t = e.changedTouches[0];
    if (!t || !timer) return;
    if (Math.hypot(t.clientX - startX, t.clientY - startY) > 10) clearTimer();
  }, { passive: true });
  el.addEventListener("touchend", clearTimer);
  el.addEventListener("touchcancel", clearTimer);
  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch" || e.pointerType === "pen") return;
    if (e.button !== 0) return;
    start(e.clientX, e.clientY);
  });
  el.addEventListener("pointermove", (e) => {
    if (!timer) return;
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 10) clearTimer();
  });
  el.addEventListener("pointerup", clearTimer);
  el.addEventListener("pointercancel", clearTimer);
  el.addEventListener("pointerleave", clearTimer);
  return { unbind: clearTimer };
}

export function bindContextMenu(el, getItems, { readOnly = false } = {}) {
  if (el.tabIndex < 0) el.tabIndex = 0;
  const open = (e) => {
    e?.preventDefault?.();
    const items = typeof getItems === "function" ? getItems() : getItems;
    if (!items || !items.length) return;
    openContextMenu(items, { readOnly });
  };
  bindLongPress(el, () => open());
  el.addEventListener("contextmenu", (e) => { e.preventDefault(); open(e); });
  el.addEventListener("keydown", (e) => {
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      open(e);
    }
  });
}

/* ---------- WU-04 SearchableSel ---------- */

export function searchableSel({ label, value, onChange, options = [], placeholder = "Search...", disabled, autoOpen } = {}) {
  const wrap = (el) => (label ? field(label, el) : el);

  if (options.length < 6) {
    const sel = h("select", {
      class: "input",
      value: value ?? "",
      disabled: !!disabled,
      onchange: (e) => onChange?.(e.target.value),
    }, ...options.map((o) => h("option", { value: o.value, text: o.label, selected: o.value === value })));
    if (value != null) sel.value = value;
    return wrap(sel);
  }

  const selected = () => options.find((o) => o.value === value);
  const root = h("div", { class: "ssel" });
  const trigger = h("button", {
    type: "button",
    class: "input ssel-trigger",
    disabled: !!disabled,
    onclick: () => { if (!disabled) toggle(); },
  });
  const paintTrigger = () => {
    const sel = selected();
    clear(trigger);
    append(trigger,
      h("span", { class: "ssel-value", text: sel ? sel.label : (placeholder || "Select...") }),
      h("span", { class: "ssel-caret", text: open ? "▲" : "▼" }),
    );
    trigger.classList.toggle("placeholder", !sel);
  };

  let open = false;
  let q = "";
  let overlay = null;

  const close = () => {
    open = false;
    overlay?.remove();
    overlay = null;
    paintTrigger();
  };

  const openOverlay = () => {
    open = true;
    q = "";
    overlay = h("div", { class: "ssel-overlay", onclick: (e) => { if (e.target === overlay) close(); } });
    const panel = h("div", { class: "ssel-panel", onclick: (e) => e.stopPropagation() });
    const input = h("input", {
      class: "input ssel-search",
      type: "text",
      placeholder,
      value: "",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
    });
    const list = h("div", { class: "ssel-list" });
    const paintList = () => {
      const qLow = q.trim().toLowerCase();
      const filtered = qLow
        ? options.filter((o) => o.label.toLowerCase().includes(qLow) || (o.group || "").toLowerCase().includes(qLow))
        : options;
      clear(list);
      if (!filtered.length) {
        list.append(h("div", { class: "ssel-empty", text: "No matches" }));
        return;
      }
      const groups = [];
      for (const o of filtered) {
        const g = o.group || "";
        let grp = groups.find((x) => x.label === g);
        if (!grp) { grp = { label: g, items: [] }; groups.push(grp); }
        grp.items.push(o);
      }
      for (const grp of groups) {
        const block = h("div", { class: "ssel-group" });
        if (grp.label) block.append(h("div", { class: "ssel-group-label", text: grp.label }));
        for (const o of grp.items) {
          block.append(h("button", {
            type: "button",
            class: `ssel-option${o.value === value ? " on" : ""}`,
            text: o.label,
            onclick: () => { onChange?.(o.value); close(); },
          }));
        }
        list.append(block);
      }
    };
    input.addEventListener("input", () => { q = input.value; paintList(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      if (e.key === "Enter") {
        e.preventDefault();
        const qLow = q.trim().toLowerCase();
        const first = options.find((o) => !qLow || o.label.toLowerCase().includes(qLow) || (o.group || "").toLowerCase().includes(qLow));
        if (first) { onChange?.(first.value); close(); }
      }
    });
    panel.append(
      h("div", { class: "ssel-search-row" },
        input,
        h("button", { type: "button", class: "ssel-x", text: "×", "aria-label": "Close", onclick: close }),
      ),
      list,
    );
    overlay.append(panel);
    document.body.append(overlay);
    paintList();
    paintTrigger();
    queueMicrotask(() => input.focus());
  };

  const toggle = () => { if (open) close(); else openOverlay(); };
  paintTrigger();
  root.append(trigger);
  if (autoOpen && !disabled) queueMicrotask(() => openOverlay());
  return wrap(root);
}

/* ---------- WU-05 amount input + docked pad ---------- */

let dockedPad = null;

function formatPlainAmount(s) {
  if (s === "" || s === "-") return s;
  const neg = String(s).startsWith("-");
  const raw = String(s).replace(/^-/, "");
  if (raw === "" || raw === ".") return (neg ? "-" : "") + raw;
  const [w, frac] = raw.split(".");
  const n = Number(w || "0");
  if (!Number.isFinite(n)) return s;
  const whole = Math.abs(n).toLocaleString("en-US");
  const out = frac !== undefined ? `${whole}.${frac}` : whole;
  return (neg || n < 0 ? "-" : "") + out;
}

export function closePad() {
  dockedPad?.remove();
  dockedPad = null;
}

export function openPad({ title = "Amount", value = 0, onCommit, onChange, allowNegative = false, sign, onToggleSign, fieldEl } = {}) {
  closePad();
  let expr = value && Number(value) ? String(round2(value)) : "";
  let negative = Number(value) < 0 || sign === "−" || sign === "-";
  let replace = expr.length > 0;
  const signed = (n) => (negative ? -Math.abs(n) : Math.abs(n));

  const display = h("div", { class: "dock-raw" });
  const preview = h("div", { class: "dock-preview" });
  const paint = () => {
    const shown = hasOp(expr) ? `$${expr}` : (expr ? formatPlainAmount(expr) : "");
    display.textContent = shown || "0.00";
    display.classList.toggle("empty", !expr);
    const pv = hasOp(expr) && expr.trim() ? evalMath(expr) : null;
    preview.textContent = pv != null && pv !== (parseFloat(expr) || 0) ? `= ${fmt(pv)}` : "";
  };

  const press = (val) => {
    if (replace) {
      const isOp = /[+\-*/]/.test(val);
      expr = isOp ? (expr + val) : (val === "." ? "0." : val);
      replace = false;
      if (onChange && !hasOp(expr)) onChange(parseFloat(expr) || 0);
      paint();
      return;
    }
    if (val === ".") {
      const opMatch = expr.match(/[+\-*/](?=[^+\-*/]*$)/);
      const segment = opMatch ? expr.slice(expr.lastIndexOf(opMatch[0]) + 1) : expr;
      if (segment.includes(".")) return;
    }
    if (/[0-9]/.test(val)) {
      const opMatch = expr.match(/[+\-*/](?=[^+\-*/]*$)/);
      const segment = opMatch ? expr.slice(expr.lastIndexOf(opMatch[0]) + 1) : expr;
      const dotIdx = segment.indexOf(".");
      if (dotIdx !== -1 && segment.length - dotIdx > 2) return;
    }
    expr = (expr + val).replace(/[^0-9+\-*/.()]/g, "");
    if (onChange && !hasOp(expr)) onChange(parseFloat(expr) || 0);
    paint();
  };

  const commit = () => {
    const n = signed(hasOp(expr) ? (evalMath(expr) || 0) : (parseFloat(expr) || 0));
    closePad();
    onCommit?.(round2(n));
  };

  const backdrop = h("div", { class: "dock-backdrop", onpointerdown: (e) => { e.preventDefault(); e.stopPropagation(); commit(); } });
  const pad = h("div", { class: "dock-pad", onpointerdown: (e) => e.stopPropagation(), onclick: (e) => e.stopPropagation() });
  const signBtn = (allowNegative || onToggleSign || sign)
    ? h("button", {
      type: "button", class: "dock-sign",
      text: negative ? "−" : "+",
      onpointerdown: (e) => {
        e.preventDefault();
        negative = !negative;
        e.currentTarget.textContent = negative ? "−" : "+";
        e.currentTarget.classList.toggle("neg", negative);
        onToggleSign?.();
      },
    })
    : null;
  if (signBtn && negative) signBtn.classList.add("neg");

  pad.append(
    h("div", { class: "dock-mirror" },
      title ? h("div", { class: "dock-label", text: title }) : null,
      h("div", { class: "dock-row" },
        signBtn,
        display,
        preview,
        h("button", { type: "button", class: "dock-x", text: "✕", "aria-label": "Discard", onpointerdown: (e) => { e.preventDefault(); e.stopPropagation(); closePad(); } }),
      ),
    ),
  );

  const rows = [
    [["7", "7"], ["8", "8"], ["9", "9"], ["÷", "/"]],
    [["4", "4"], ["5", "5"], ["6", "6"], ["×", "*"]],
    [["1", "1"], ["2", "2"], ["3", "3"], ["−", "-"]],
    [[".", "."], ["0", "0"], ["⌫", "BACK"], ["+", "+"]],
  ];
  const grid = h("div", { class: "dock-grid" });
  for (const row of rows) {
    const r = h("div", { class: "dock-keys" });
    for (const [lab, val] of row) {
      r.append(h("button", {
        type: "button",
        class: `dock-key${val === "BACK" ? " back" : (/^[+\-*/]$/.test(val) ? " op" : "")}`,
        text: lab,
        onpointerdown: (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (val === "BACK") { replace = false; expr = expr.slice(0, -1); paint(); return; }
          press(val);
        },
      }));
    }
    grid.append(r);
  }
  grid.append(h("div", { class: "dock-keys dock-actions" },
    h("button", { type: "button", class: "dock-key back", text: "Clear", onpointerdown: (e) => { e.preventDefault(); expr = ""; replace = false; onChange?.(0); paint(); } }),
    h("button", { type: "button", class: "dock-key done", text: "✓  Done", onpointerdown: (e) => { e.preventDefault(); commit(); } }),
  ));
  pad.append(grid);
  const host = h("div", { class: "dock-host" }, backdrop, pad);
  document.body.append(host);
  dockedPad = host;
  paint();
  if (fieldEl?.scrollIntoView) fieldEl.scrollIntoView({ block: "center", behavior: "smooth" });
  return { close: closePad, commit };
}

export function amountInput({ value = 0, onCommit, onChange, label, allowNegative = false, disabled, placeholder } = {}) {
  let raw = value && Number(value) ? String(round2(value)) : "";
  const input = h("input", {
    class: "input amount-input",
    type: "text",
    inputmode: "decimal",
    placeholder: placeholder || "0.00",
    value: raw ? formatPlainAmount(raw) : "",
    disabled: !!disabled,
    autocomplete: "off",
  });
  const commitFromRaw = () => {
    const n = hasOp(raw) ? (evalMath(raw) || 0) : (parseFloat(raw) || 0);
    onCommit?.(round2(n));
  };
  input.addEventListener("focus", (e) => {
    if (disabled) return;
    if (isTouchUi()) {
      e.preventDefault();
      input.blur();
      openPad({
        title: label || "Amount",
        value: hasOp(raw) ? (evalMath(raw) || 0) : (parseFloat(raw) || 0),
        allowNegative,
        fieldEl: input,
        onChange,
        onCommit: (n) => {
          raw = n ? String(round2(n)) : "";
          input.value = raw ? formatPlainAmount(raw) : "";
          onCommit?.(n);
        },
      });
    }
  });
  input.addEventListener("input", () => {
    const cleaned = input.value.replace(/[$,]/g, "");
    raw = hasOp(cleaned) ? cleaned.replace(/[^0-9+\-*/.() ]/g, "") : cleaned.replace(/[^0-9.+\-]/g, "");
    if (onChange && !hasOp(raw)) onChange(parseFloat(raw) || 0);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitFromRaw(); }
    if (e.key === "Escape") input.blur();
  });
  input.addEventListener("blur", () => { if (!isTouchUi()) commitFromRaw(); });
  return label ? field(label, input) : input;
}
