import { h, btn, openSheet, field, textInput, toast, confirmDialog } from "../ui.js?v=154";
import { APP_VERSION, toTitleCase, uid } from "../util.js?v=154";
import { exportData, deviceGet, deviceSet, importData } from "../store.js?v=154";
import { freshBudgetShell, copyCategories, addAccount, addCreditCard } from "../mutate.js?v=154";
import { requestPermission, scheduleLocal } from "../notify.js?v=154";
import { isIOS, isStandalone, canInstall, promptInstall } from "../pwa.js?v=154";
import { openWhatsNew } from "../whatsnew.js?v=154";
import { THEMES, paintTheme, deriveCustom, resolveTheme, customFrom } from "../theme.js?v=154";
import { bankSection, openBankSheet } from "./bank.js?v=154";
import { householdSection } from "./household.js?v=154";

export async function renderSettings(root, ctx) {
  const budget = ctx.budget();
  const user = (ctx.state.users || []).find((u) => u.userId === ctx.state.activeUserId);
  const theme = (await deviceGet("theme")) || "system";
  const perm = "Notification" in window ? Notification.permission : "unsupported";

  root.append(h("header", { class: "view-head" }, h("h1", { text: "Settings" })));
  root.append(section("Household", await householdSection(ctx)));
  const budgets = (ctx.state.budgets || []).filter((b) => !b.archived);
  const others = (ctx.state.budgets || []).filter((b) => b.archived);
  root.append(section("Budgets", [
    ...budgets.map((b) => h("div", { class: "line" },
      h("span", {}, h("strong", { text: b.name }), b.id === ctx.state.activeBudgetId ? h("span", { class: "muted", text: " · current" }) : null),
      h("span", { class: "row gap" },
        b.id === ctx.state.activeBudgetId ? null : btn("Open", { kind: "quiet", onClick: () => ctx.commit({ ...ctx.state, activeBudgetId: b.id, setupComplete: true }) }),
        btn(b.archived ? "Restore" : "Archive", { kind: "quiet", onClick: () => {
          const next = ctx.state.budgets.map((x) => x.id === b.id ? { ...x, archived: !x.archived } : x);
          const active = next.find((x) => !x.archived) || next[0];
          ctx.commit({ ...ctx.state, budgets: next, activeBudgetId: b.id === ctx.state.activeBudgetId ? active?.id || null : ctx.state.activeBudgetId, setupComplete: !!active && !active.archived });
        }}),
        btn("Delete", { kind: "quiet", onClick: () => confirmDialog({
          title: `Delete ${b.name}?`,
          message: "This removes the budget from this device. Export a backup first if you might want it back.",
          confirm: "Delete",
          danger: true,
          onConfirm: () => {
            const next = ctx.state.budgets.filter((x) => x.id !== b.id);
            ctx.commit({ ...ctx.state, budgets: next, activeBudgetId: ctx.state.activeBudgetId === b.id ? (next.find((x) => !x.archived)?.id || null) : ctx.state.activeBudgetId, setupComplete: next.some((x) => !x.archived) });
          },
        }) }),
      ),
    )),
    others.length ? h("p", { class: "hint", text: `${others.length} archived.` }) : null,
  ]));
  root.append(section("Budget", [
    line(budget?.name || "Budget", "Rename", () => renameBudget(ctx)),
    line("New budget", "Create", () => newBudget(ctx)),
    line("Accounts and cards", "Add", () => ctx.go("accounts")),
  ]));
  root.append(section("Backup", [
    line("Export JSON", "Download", () => download(ctx)),
    line("Copy backup", "Copy", () => copyBackup(ctx)),
    line("Paste backup", "Paste", () => pasteBackup(ctx)),
    line("Import JSON", "Choose file", () => importFile(ctx)),
    line("Reset this device", "Reset", () => confirmDialog({
      title: "Erase local data?",
      message: ctx.account?.token
        ? "This signs this device out and deletes the budget on this device only. Your household’s budget stays safe on the server."
        : "This deletes budgets on this device. Export a backup first if you might want them back.",
      confirm: "Erase", danger: true, onConfirm: () => ctx.reset(),
    })),
  ]));
  root.append(section("Bank sync", await bankSection(ctx)));
  if (ctx.ui.openBank) {
    ctx.ui.openBank = false;
    setTimeout(() => openBankSheet(ctx), 0);
  }
  const stored = resolveTheme(theme);
  const customSaved = await deviceGet("customTheme");
  const phoneDark = matchMedia("(prefers-color-scheme: dark)").matches;
  const grid = h("div", { class: "theme-grid" });
  for (const id of ["standard", "paper", "ink", "dusk"]) {
    const t = THEMES[id];
    grid.append(themeSwatch(t, stored === id, async () => {
      await deviceSet("theme", id);
      paintTheme(id);
      ctx.render();
    }));
  }
  const customFace = deriveCustom(customSaved || {});
  grid.append(themeSwatch({
    name: "Custom", hint: "Your colors",
    bg: customFace.bg, surface: customFace.surface, ink: customFace.ink, accent: customFace.accent, band: customFace.band,
  }, stored === "custom", async () => {
    const saved = await deviceGet("customTheme");
    if (!saved) { openCustomTheme(ctx, null); return; }
    await deviceSet("theme", "custom");
    paintTheme("custom", saved);
    ctx.render();
  }));
  grid.append(themeSwatch({
    name: "Match this phone", hint: "Standard in light, Ink in dark",
    bg: THEMES.standard.bg, surface: THEMES.standard.surface, ink: THEMES.standard.ink, accent: THEMES.standard.accent, band: THEMES.standard.band,
  }, stored === "system", async () => {
    await deviceSet("theme", "system");
    paintTheme("system");
    ctx.render();
  }));
  const appearance = [grid];
  if (stored === "system") appearance.push(h("p", { class: "hint theme-note", text: "Following this phone until you pick a theme." }));
  if (stored === "custom") appearance.push(btn("Edit colors", { kind: "ghost", block: true, onClick: () => openCustomTheme(ctx, customSaved) }));
  root.append(section("Appearance", appearance));
  const notif = section("Notifications", [
    h("p", { class: "hint", text: `Permission: ${perm}.` }),
    isIOS() && !isStandalone() ? h("p", { class: "hint", text: "On iPhone, add ToozBudgeting to the Home Screen before notifications can show. iOS 16.4 or later." }) : null,
    btn(perm === "granted" ? "Notifications allowed" : "Allow notifications", { block: true, kind: "ghost", disabled: perm === "granted", onClick: async () => { await requestPermission(); scheduleLocal(ctx.budget(), ctx.month); ctx.render(); } }),
  ]);
  root.append(notif);
  // Google sign-in replaces the old on-device accounts: once signed in, this section is gone (Household shows who you are).
  // Before that, it only names the local profile and points to Google, instead of asking for an email and password.
  if (!user?.account && !ctx.account?.token) root.append(section("Profile on this device", [
    h("p", { text: user ? `${user.displayName}${user.isGuest ? " · guest" : ""} · only on this device` : "Signed out" }),
    h("p", { class: "hint", text: "To use the same budget on every phone and share it with your household, use Sign in with Google under Household above." }),
    btn("Log out", { kind: "danger", block: true, onClick: () => confirmDialog({
      title: "Log out?",
      message: "This ends the session on this device. The budget stays here so you can log in again.",
      confirm: "Log out",
      onConfirm: () => ctx.logOut(),
    })}),
  ]));
  root.append(h("p", { class: "hint", text: `ToozBudgeting ${APP_VERSION}` }));
  root.append(h("p", { class: "hint legal-links" }, h("a", { href: "./privacy.html", text: "Privacy" }), " · ", h("a", { href: "./terms.html", text: "Terms" })));
  root.append(btn("What's new", { kind: "quiet", block: true, onClick: () => openWhatsNew() }));
  if (canInstall() || (isIOS() && !isStandalone())) {
    root.append(btn("Install app", { block: true, kind: "ghost", onClick: async () => {
      const res = await promptInstall();
      if (res.reason === "ios") toast("On iPhone: Share, then Add to Home Screen.");
    }}));
  }
}

function section(title, kids) {
  return h("section", { class: "group settings-block" }, h("h2", { text: title }), ...kids);
}

function themeSwatch(theme, on, onClick) {
  return h("button", {
    type: "button",
    class: `theme-swatch${on ? " on" : ""}`,
    style: `--sw-bg:${theme.bg};--sw-surface:${theme.surface};--sw-ink:${theme.ink};--sw-accent:${theme.accent};--sw-band:${theme.band}`,
    onclick: onClick,
  },
    h("span", { class: "swatch-face", "aria-hidden": "true" }),
    h("span", { class: "swatch-name", text: theme.name }),
    h("span", { class: "swatch-hint", text: theme.hint }),
  );
}

function openCustomTheme(ctx, saved) {
  const draft = customFrom(saved || {});
  const sheet = openSheet({
    title: "Custom theme",
    body: (host) => {
      const preview = h("div", { class: "theme-preview" });
      const paint = () => {
        const d = deriveCustom(draft);
        preview.replaceChildren(
          h("div", { class: "theme-preview-band", text: "Bills", style: `background:${d.band};color:${d.ink}` }),
          h("div", { class: "theme-preview-row", style: `background:${d.surface};color:${d.ink}` },
            h("span", { text: "Groceries" }),
            h("strong", { text: "$120.00", style: `color:${d.vars["--good"]}` }),
          ),
          h("div", { style: `background:${d.surface};padding:0 12px 12px` },
            h("div", { text: "Button", style: `display:inline-flex;align-items:center;min-height:40px;padding:0 14px;border-radius:12px;background:${d.accent};color:${d.vars["--accent-ink"]};font-weight:600` }),
          ),
        );
      };
      const picker = (label, key) => {
        const input = h("input", { class: "input", type: "color", value: draft[key], "aria-label": label });
        input.addEventListener("input", () => { draft[key] = input.value; paint(); });
        return field(label, input);
      };
      host.append(
        h("p", { class: "hint", text: "Set the background, the cards, the text, and one accent. Everything else follows from those." }),
        preview,
        picker("Background", "bg"),
        picker("Cards", "surface"),
        picker("Text", "ink"),
        picker("Accent", "accent"),
        btn("Use this theme", { block: true, onClick: async () => {
          const next = customFrom(draft);
          await deviceSet("customTheme", next);
          await deviceSet("theme", "custom");
          paintTheme("custom", next);
          sheet.close();
          ctx.render();
        }}),
      );
      paint();
    },
  });
}

function line(label, action, onClick, kind = "quiet") {
  const tone = label.startsWith("Reset") ? "danger" : kind;
  return h("div", { class: "line" }, h("span", { text: label }), btn(action, { kind: tone, onClick }));
}

function renameBudget(ctx) {
  const input = textInput({ value: ctx.budget().name });
  const sheet = openSheet({ title: "Rename budget", body: (host) => {
    host.append(field("Name", input), btn("Save", { block: true, onClick: () => {
      const name = toTitleCase(input.value.trim());
      if (!name) return;
      if (ctx.state.budgets.some((b) => b.id !== ctx.budget().id && b.name.toLowerCase() === name.toLowerCase())) { toast("A budget with that name already exists"); return; }
      ctx.updateBudget((b) => ({ ...b, name }));
      sheet.close();
    }}));
  }});
}

function newBudget(ctx) {
  const input = textInput({ value: "New budget" });
  let copyFrom = ctx.budget()?.id || "";
  const sheet = openSheet({ title: "New budget", body: (host) => {
    const sel = h("select", { class: "input" }, h("option", { value: "", text: "Start empty" }));
    for (const b of ctx.state.budgets || []) sel.append(h("option", { value: b.id, text: `Copy categories from ${b.name}` }));
    sel.value = copyFrom;
    sel.addEventListener("change", () => { copyFrom = sel.value; });
    host.append(field("Name", input), field("Categories", sel), btn("Create", { block: true, onClick: () => {
      const name = toTitleCase(input.value.trim() || "New budget");
      let b = freshBudgetShell(name, ctx.state.activeUserId);
      const source = (ctx.state.budgets || []).find((x) => x.id === copyFrom);
      if (source) {
        const copied = copyCategories(source);
        b = { ...b, categoryGroups: copied.groups, categories: copied.categories };
      }
      ctx.addBudget(b);
      sheet.close();
    }}));
  }});
}

function download(ctx) {
  const data = exportData(ctx.state);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `toozbudgeting-${todayStamp()}.json` });
  a.click();
  toast("Backup downloaded");
}
async function copyBackup(ctx) {
  try {
    await navigator.clipboard.writeText(JSON.stringify(exportData(ctx.state), null, 2));
    toast("Backup copied");
  } catch { toast("Couldn’t copy. Download the file instead."); }
}
async function pasteBackup(ctx) {
  try {
    ctx.restore(importData(JSON.parse(await navigator.clipboard.readText())));
    toast("Backup restored");
  } catch { toast("Clipboard doesn’t contain a valid backup"); }
}
function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}
function importFile(ctx) {
  const input = h("input", { type: "file", accept: "application/json,.json" });
  input.addEventListener("change", async () => {
    const f = input.files?.[0]; if (!f) return;
    try {
      const parsed = JSON.parse(await f.text());
      ctx.restore(parsed.budgets ? (await import("../store.js?v=154")).importData(parsed) : parsed);
      toast("Imported");
    } catch (e) { toast(e.message || "Couldn’t import that file"); }
  });
  input.click();
}


function upgrade(ctx, user) {
  const name = textInput({ value: user?.displayName?.startsWith("Guest-") ? "" : (user?.displayName || "") });
  const email = textInput({ type: "email", placeholder: "you@example.com" });
  const pass = textInput({ type: "password", placeholder: "At least 6 characters" });
  const err = h("p", { class: "error", text: "" });
  const sheet = openSheet({ title: "Save an account", body: (host) => {
    host.append(field("Display name", name), field("Email", email), field("Password", pass), err,
      btn("Save on this device", { block: true, onClick: () => {
        if (!name.value.trim() || !email.value.includes("@") || pass.value.length < 6) { err.textContent = "Name, a valid email, and a 6+ character password are required."; return; }
        ctx.saveUser({ ...user, displayName: name.value.trim(), email: email.value.trim(), passwordHash: pass.value, isGuest: false });
        sheet.close();
      }}));
  }});
}

void addAccount;
void addCreditCard;
