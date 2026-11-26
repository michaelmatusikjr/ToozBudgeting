/** DOM helpers, toasts, sheets, and the amount pad. User text always goes through textContent. */
import { evalMath, fmt, hasOp, round2 } from "./util.js";

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

export function icon(name) {
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
    undo: '<path d="M8 8H4v4"/><path d="M4 8a8 8 0 1 1-1 6"/>',
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
export function closeModal() {
  const top = stack.pop();
  top?.remove();
  if (!stack.length) document.body.classList.remove("modal-open");
}
export function closeAllModals() {
  while (stack.length) closeModal();
}

export function openSheet({ title, body, onClose }) {
  document.body.classList.add("modal-open");
  const scrim = h("div", { class: "scrim", onclick: (e) => { if (e.target === scrim) { closeModal(); onClose?.(); } } });
  const sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true" });
  const head = h("div", { class: "sheet-head" },
    h("h2", { class: "sheet-title", text: title || "" }),
    h("button", { class: "icon-btn", type: "button", "aria-label": "Close", onclick: () => { closeModal(); onClose?.(); } }, icon("close")),
  );
  const content = h("div", { class: "sheet-body" });
  if (typeof body === "function") body(content);
  else if (body) content.append(body);
  sheet.append(head, content);
  scrim.append(sheet);
  document.body.append(scrim);
  stack.push(scrim);
  const focusable = sheet.querySelector("input, select, textarea, button");
  focusable?.focus?.();
  return { content, close: () => { if (stack.includes(scrim)) { stack.splice(stack.indexOf(scrim), 1); scrim.remove(); if (!stack.length) document.body.classList.remove("modal-open"); } } };
}

export function field(label, control) {
  return h("label", { class: "field" }, h("span", { class: "field-label", text: label }), control);
}

export function textInput(opts = {}) {
  return h("input", { class: "input", type: opts.type || "text", placeholder: opts.placeholder || "", value: opts.value || "", autocomplete: "off" });
}

export function btn(label, opts = {}) {
  return h("button", { class: `btn ${opts.kind || "primary"} ${opts.block ? "block" : ""}`, type: "button", disabled: !!opts.disabled, onclick: opts.onClick }, opts.icon ? icon(opts.icon) : null, h("span", { text: label }));
}

let padState = null;
export function openAmountPad({ title = "Amount", value = 0, onCommit, allowNegative = false }) {
  let expr = value ? String(round2(value)) : "";
  let negative = Number(value) < 0;
  const display = h("div", { class: "pad-display", text: expr || "0" });
  const preview = h("div", { class: "pad-preview", text: "" });
  const paint = () => {
    display.textContent = (negative && expr && !expr.startsWith("-") ? "−" : "") + (expr || "0");
    preview.textContent = hasOp(expr) ? fmt(signed(evalMath(expr))) : "";
  };
  const signed = (n) => (negative ? -Math.abs(n) : n);
  const push = (ch) => {
    if (ch === "." && expr.split(/[-+*/]/).pop().includes(".")) return;
    expr += ch;
    paint();
  };
  const keys = ["7", "8", "9", "/", "4", "5", "6", "*", "1", "2", "3", "-", "0", ".", "⌫", "+"];
  const grid = h("div", { class: "pad-grid" });
  for (const k of keys) {
    grid.append(h("button", {
      type: "button", class: `pad-key ${"+-*/".includes(k) ? "op" : ""}`, text: k,
      onclick: () => {
        if (k === "⌫") { expr = expr.slice(0, -1); paint(); return; }
        push(k);
      },
    }));
  }
  const sheet = openSheet({
    title,
    body: (root) => {
      root.append(display, preview, grid);
      const row = h("div", { class: "row gap" });
      if (allowNegative) row.append(btn(negative ? "Spending" : "Refund", { kind: "ghost", onClick: () => { negative = !negative; paint(); } }));
      row.append(btn("Done", { block: true, onClick: () => { const n = signed(evalMath(expr || "0")); sheet.close(); onCommit?.(round2(n)); } }));
      root.append(row);
      paint();
    },
  });
  padState = sheet;
  return sheet;
}

export function moneyButton(value, onCommit, { allowNegative = false, label } = {}) {
  const b = h("button", { type: "button", class: "money-btn", onclick: () => openAmountPad({ title: label || "Amount", value, allowNegative, onCommit: (n) => { b.textContent = fmt(n); b.dataset.value = String(n); onCommit(n); } }) });
  b.textContent = fmt(value || 0);
  b.dataset.value = String(value || 0);
  return b;
}

export function confirmDialog({ title, message, confirm = "Confirm", danger = false, onConfirm }) {
  const sheet = openSheet({
    title,
    body: (root) => {
      root.append(h("p", { class: "lede", text: message }));
      const row = h("div", { class: "row gap" },
        btn("Cancel", { kind: "ghost", onClick: () => sheet.close() }),
        btn(confirm, { kind: danger ? "danger" : "primary", onClick: () => { sheet.close(); onConfirm?.(); } }),
      );
      root.append(row);
    },
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && stack.length) { e.preventDefault(); closeModal(); }
});
