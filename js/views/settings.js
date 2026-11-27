import { h, btn, openSheet, field, textInput, toast, confirmDialog, bindContextMenu, devHooks } from "../ui.js?v=154";
import { APP_VERSION, toTitleCase, uid } from "../util.js?v=154";
import { exportData, deviceGet, deviceSet, importData } from "../store.js?v=154";
import { freshBudgetShell, copyCategories, addAccount, addCreditCard } from "../mutate.js?v=154";
import { requestPermission, scheduleLocal } from "../notify.js?v=154";
import { isIOS, isStandalone, canInstall, promptInstall } from "../pwa.js?v=154";
import { openWhatsNew } from "../whatsnew.js?v=154";
import { THEMES, paintTheme, deriveCustom, resolveTheme, customFrom } from "../theme.js?v=154";
import { renderGoogleButton, signOut } from "../account.js?v=154";
import { bankSection, openBankSheet } from "./bank.js?v=154";
import { householdSection, openPeople, avatar } from "./household.js?v=154";

export async function renderSettings(root, ctx) {
  const budget = ctx.budget();
  const user = (ctx.state.users || []).find((u) => u.userId === ctx.state.activeUserId);
  const theme = (await deviceGet("theme")) || "system";
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  const signedIn = !!ctx.account?.token;
  const me = ctx.account?.me?.user || {};
  const TABS = [["account", "👤", "Account"], ["budgets", "💰", "Budgets"], ["data", "💾", "Data"]];
  let tab = ctx.ui.settingsTab;
  if (!TABS.some(([id]) => id === tab)) {
    tab = (await deviceGet("settingsTab")) || "account";
    if (!TABS.some(([id]) => id === tab)) tab = "account";
    ctx.ui.settingsTab = tab;
  }

  const tabs = h("div", { class: "set-tabs", role: "tablist" });
  for (const [id, icon, label] of TABS) {
    const on = tab === id;
    tabs.append(h("button", {
      type: "button",
      class: `set-tab${on ? " on" : ""}`,
      role: "tab",
      "aria-selected": on ? "true" : "false",
      onclick: async () => {
        ctx.ui.settingsTab = id;
        await deviceSet("settingsTab", id);
        ctx.render();
      },
    }, h("span", { text: icon }), h("span", { text: label })));
  }
  root.append(tabs);
  const pane = h("div", { class: "set-pane" });

  if (tab === "account") {
    pane.append(accountCard(ctx, user, signedIn, me));
    const house = h("div", { class: "set-sec" }, h("div", { class: "set-sec-h", text: "Household" }));
    const houseBody = h("div", { class: "set-card set-household" });
    for (const kid of (await householdSection(ctx)) || []) houseBody.append(kid);
    house.append(houseBody);
    pane.append(house);
    if (!user?.account && !ctx.account?.token) {
      pane.append(setSec("Profile on this device",
        h("div", { class: "set-card" },
          h("p", { class: "set-profile-line", text: user ? `${user.displayName}${user.isGuest ? " · guest" : ""} · only on this device` : "Signed out" }),
          h("p", { class: "set-profile-hint", text: "To use the same budget on every phone and share it with your household, use Sign in with Google above. Log Out is on the Account card." }),
        ),
      ));
    }
    pane.append(await appearanceSection(ctx, theme));
    const notifKids = [
      h("p", { class: "set-profile-hint", text: `Permission: ${perm}.` }),
      isIOS() && !isStandalone() ? h("p", { class: "set-profile-hint", text: "On iPhone, add ToozBudgeting to the Home Screen before notifications can show. iOS 16.4 or later." }) : null,
      btn(perm === "granted" ? "Notifications allowed" : "Allow notifications", { block: true, kind: "ghost", disabled: perm === "granted", onClick: async () => { await requestPermission(); scheduleLocal(ctx.budget(), ctx.month); ctx.render(); } }),
    ];
    pane.append(setSec("Notifications", h("div", { class: "set-card" }, ...notifKids.filter(Boolean))));
  }

  if (tab === "budgets") {
    pane.append(setSec("This budget",
      h("div", { class: "set-card" },
        line(budget?.name || "Budget", "Rename", () => renameBudget(ctx, budget?.id)),
        line("Accounts and cards", "Add", () => ctx.go("accounts")),
      ),
    ));
    const activeBudgets = (ctx.state.budgets || []).filter((b) => !b.archived);
    const archivedBudgets = (ctx.state.budgets || []).filter((b) => b.archived);
    pane.append(h("div", { class: "set-sec-h", text: "Active Budgets" }));
    for (const b of activeBudgets) pane.append(budgetCard(ctx, b, false));
    if (archivedBudgets.length) {
      pane.append(h("div", { class: "set-sec-h set-sec-h-gap", text: "Archived" }));
      for (const b of archivedBudgets) pane.append(budgetCard(ctx, b, true));
    }
    const create = btn("+ Create New Budget", { kind: "primary", block: true, onClick: () => newBudget(ctx) });
    create.classList.add("set-create");
    if (ctx.readOnly()) create.disabled = true;
    pane.append(create);
  }

  if (tab === "data") {
    pane.append(h("div", { class: "set-sec-h", text: "Backup & Restore" }));
    pane.append(h("p", { class: "set-lede", text: "Export a backup file of everything in ToozBudgeting — all budgets, accounts, transactions, and settings. Keep it somewhere safe so you can restore it later if needed." }));
    pane.append(btn("📤 Export Backup", { kind: "primary", block: true, onClick: () => download(ctx) }));
    pane.append(h("div", { class: "set-sec-h set-sec-h-gap", text: "Restore from Backup" }));
    pane.append(h("p", { class: "set-lede" },
      "Choose a backup file you exported earlier. This ",
      h("strong", { text: "replaces everything" }),
      " currently in ToozBudgeting.",
    ));
    const importErr = h("div", { class: "set-budget-err" });
    pane.append(btn("📥 Import Backup", { kind: "navy-out", block: true, onClick: () => importFile(ctx, importErr) }), importErr);
    const clip = h("div", { class: "set-clip" },
      h("div", { class: "set-clip-h", text: "📱 Mobile Clipboard Backup" }),
      h("div", { class: "set-clip-p", text: "Use these if the export/import buttons above don't work on your device. Copy copies the full backup JSON to your clipboard. Paste reads JSON from your clipboard to restore." }),
      btn("📋 Copy Backup to Clipboard", { kind: "amber-fill", block: true, onClick: () => copyBackup(ctx) }),
      btn("📋 Paste Backup from Clipboard", { kind: "amber", block: true, onClick: () => pasteBackup(ctx) }),
    );
    pane.append(clip);

    pane.append(setSec("Bank sync", h("div", { class: "set-card set-bank" }, ...(await bankSection(ctx)))));
    if (ctx.ui.openBank) {
      ctx.ui.openBank = false;
      setTimeout(() => openBankSheet(ctx), 0);
    }

    pane.append(h("div", { class: "set-sec-h set-sec-h-gap", text: "Factory Reset" }));
    pane.append(h("p", { class: "set-lede", text: ctx.account?.token
      ? "Wipes the budgets on this device and signs this device out, then takes you back to the setup wizard. Your household’s budget stays safe on the server. Export a backup first if you want to keep a local copy."
      : "Wipes everything stored in this copy of ToozBudgeting and takes you back to the setup wizard, as if you'd just opened it for the first time. Export a backup first if you want to keep anything." }));
    pane.append(btn("🗑 Factory Reset", { kind: "ghost danger", block: true, onClick: () => factoryReset(ctx) }));

    const tools = h("div", { class: "set-tools" });
    devHooks.settingsCard?.(tools, ctx);
    if (tools.childNodes.length) pane.append(tools);

    pane.append(h("div", { class: "set-version", text: `ToozBudgeting · v${APP_VERSION}` }));
    pane.append(h("button", { type: "button", class: "set-whatsnew", text: "What's new", onclick: () => openWhatsNew() }));
    pane.append(h("p", { class: "hint legal-links set-legal" }, h("a", { href: "./privacy.html", text: "Privacy" }), " · ", h("a", { href: "./terms.html", text: "Terms" })));
    if (canInstall() || (isIOS() && !isStandalone())) {
      pane.append(btn("Install app", { block: true, kind: "ghost", onClick: async () => {
        const res = await promptInstall();
        if (res.reason === "ios") toast("On iPhone: Share, then Add to Home Screen.");
      }}));
    }
  }

  root.append(pane);
}

function setSec(title, ...kids) {
  return h("div", { class: "set-sec" }, title ? h("div", { class: "set-sec-h", text: title }) : null, ...kids.filter(Boolean));
}

function accountCard(ctx, user, signedIn, me) {
  const wrap = h("div", { class: "set-account" });
  const displayName = signedIn
    ? (me.displayName || me.name || user?.displayName || "Signed in")
    : (user?.displayName || "Guest");
  const meta = signedIn ? (me.email || "") : (user?.isGuest || !user?.email ? "Guest account" : user.email);
  const ident = h("div", { class: "set-card set-ident-card" });
  const row = h("div", { class: "set-ident" });
  if (signedIn && me.picture) row.append(avatar(me, 44));
  else {
    row.append(h("div", { class: "set-avatar", text: String(displayName).slice(0, 1).toUpperCase() }));
  }
  const nameBox = h("div", { class: "set-ident-text" });
  if (!signedIn && user) {
    const nameRow = h("button", { type: "button", class: "set-ident-name-btn" });
    nameRow.append(h("span", { class: "set-ident-name", text: displayName }), h("span", { class: "set-ident-edit", text: "✏️" }));
    nameRow.addEventListener("click", () => editLocalName(ctx, user, nameBox, displayName));
    nameBox.append(nameRow);
  } else {
    nameBox.append(h("div", { class: "set-ident-name", text: displayName }));
  }
  nameBox.append(h("div", { class: "set-ident-meta", text: meta }));
  row.append(nameBox);
  ident.append(row);
  wrap.append(ident);

  if (!signedIn) {
    const guest = h("div", { class: "set-card set-guest" });
    guest.append(
      h("div", { class: "set-guest-title", text: "You're using a Guest account" }),
      h("div", { class: "set-guest-sub", text: "Sign in with Google to set a display name and use this budget on every phone, and to share it with your household." }),
    );
    const host = h("div", { class: "gsi-host" });
    const err = h("p", { class: "error", text: ctx.account?.signedOutReason || "" });
    setTimeout(() => renderGoogleButton(host, {
      onSignedIn: (acct) => ctx.accountSignedIn(acct),
      onError: (m) => { err.textContent = m; },
    }), 0);
    guest.append(host, err);
    wrap.append(guest);
  }

  const share = h("div", { class: "set-card set-share" });
  share.append(
    h("div", {},
      h("div", { class: "set-share-title", text: "🔒 Share Budget" }),
      h("div", { class: "set-share-sub", text: signedIn ? "Invite someone to this household" : "Sign in to share budgets" }),
    ),
    btn("Share", { kind: "ghost small", onClick: () => {
      if (signedIn) openPeople(ctx);
      else toast("Sign in with Google to invite people.");
    }}),
  );
  wrap.append(share);

  if (user?.userId || me.id) {
    wrap.append(h("div", { class: "set-uid", text: `User ID: ${me.id || user?.userId}` }));
  }

  wrap.append(btn("Log Out", {
    kind: "ghost danger",
    block: true,
    onClick: () => confirmDialog({
      title: signedIn ? "Sign out?" : "Log out?",
      message: signedIn
        ? "This device stops syncing with your household. The budget stays on this device until you sign in again."
        : "This ends the session on this device. The budget stays here so you can log in again.",
      confirm: signedIn ? "Sign out" : "Log Out",
      danger: true,
      onConfirm: async () => {
        if (signedIn) { await signOut(); ctx.accountSignedOut(); }
        else ctx.logOut();
      },
    }),
  }));
  return wrap;
}

function editLocalName(ctx, user, nameBox, current) {
  const input = textInput({ value: current });
  input.setAttribute("autofocus", "");
  const save = () => {
    const name = input.value.trim();
    if (!name) { ctx.render(); return; }
    ctx.saveUser({ ...user, displayName: name });
    ctx.render();
  };
  nameBox.replaceChildren(
    h("div", { class: "set-ident-editrow" },
      input,
      btn("Save", { kind: "good small", onClick: save }),
    ),
  );
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
  input.focus();
}

async function appearanceSection(ctx, theme) {
  const stored = resolveTheme(theme);
  const customSaved = await deviceGet("customTheme");
  const grid = h("div", { class: "theme-grid" });
  const paintPick = async (id) => {
    await deviceSet("theme", id);
    paintTheme(id);
    ctx.render();
  };
  for (const id of ["standard", "paper", "ink", "dusk"]) {
    const t = THEMES[id];
    grid.append(themeSwatch(t, stored === id, () => paintPick(id)));
  }
  const customFace = deriveCustom(customSaved || {});
  grid.append(themeSwatch({
    name: "Custom", hint: "Your colors",
    bg: customFace.bg, surface: customFace.surface, ink: customFace.ink, accent: customFace.accent, band: customFace.band,
  }, stored === "custom", async () => {
    const saved = customSaved || (await deviceGet("customTheme"));
    if (!saved) { openCustomTheme(ctx, null); return; }
    await deviceSet("theme", "custom");
    paintTheme("custom", saved);
    ctx.render();
  }));
  grid.append(themeSwatch({
    name: "Match this phone", hint: "Standard in light, Ink in dark",
    bg: THEMES.standard.bg, surface: THEMES.standard.surface, ink: THEMES.standard.ink, accent: THEMES.standard.accent, band: THEMES.standard.band,
  }, stored === "system", () => paintPick("system")));
  const kids = [grid];
  if (stored === "system") kids.push(h("p", { class: "hint theme-note", text: "Following this phone until you pick a theme." }));
  if (stored === "custom") kids.push(btn("Edit colors", { kind: "ghost", block: true, onClick: () => openCustomTheme(ctx, customSaved) }));
  return setSec("Appearance", h("div", { class: "set-card set-appearance" }, ...kids));
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

function budgetCard(ctx, b, archived) {
  const active = b.id === ctx.state.activeBudgetId;
  const ro = !!ctx.readOnly();
  const card = h("div", { class: `set-budget-card${active ? " on" : ""}${archived ? " archived" : ""}` });
  const meta = active
    ? "✓ Currently active"
    : (b.createdAt ? `Created ${new Date(b.createdAt).toLocaleDateString()}` : "");
  const info = h("div", { class: "set-budget-info" },
    h("div", { class: "set-budget-name", text: b.name }),
    meta ? h("div", { class: `set-budget-meta${active ? " on" : ""}`, text: meta }) : null,
  );
  const actions = h("div", { class: "set-budget-actions" });
  if (archived) {
    if (!ro) {
      actions.append(
        btn("Restore", { kind: "good small", onClick: () => ctx.commit({ ...ctx.state, budgets: ctx.state.budgets.map((x) => x.id === b.id ? { ...x, archived: false } : x) }) }),
        btn("Delete", { kind: "ghost danger small", onClick: () => deleteBudget(ctx, b) }),
      );
    }
  } else if (!active && !ro) {
    actions.append(
      btn("Switch", { kind: "primary small", onClick: () => ctx.commit({ ...ctx.state, activeBudgetId: b.id, setupComplete: true }) }),
      btn("Archive", { kind: "ghost small", onClick: () => ctx.commit({ ...ctx.state, budgets: ctx.state.budgets.map((x) => x.id === b.id ? { ...x, archived: true } : x) }) }),
    );
  }
  card.append(info, actions);
  bindContextMenu(card, () => [
    { label: "✏️ Rename", edit: true, onClick: () => renameBudget(ctx, b.id) },
  ], { readOnly: ro });
  return card;
}

function deleteBudget(ctx, b) {
  if (b.id === ctx.state.activeBudgetId) return;
  const sheet = openSheet({
    title: "Delete Budget?",
    body: (host) => {
      host.append(
        h("div", { class: "set-factory-warn", text: `Permanently delete "${b.name}"? All of its accounts, categories, and transaction history will be gone for good.` }),
        h("div", { class: "set-factory-note", text: "Consider exporting a backup first (Data tab) if you might want this later." }),
        btnRow(
          { label: "Cancel", kind: "ghost", onClick: () => sheet.close() },
          { label: "Delete Permanently", kind: "danger", onClick: () => {
            const next = ctx.state.budgets.filter((x) => x.id !== b.id);
            ctx.commit({ ...ctx.state, budgets: next, activeBudgetId: ctx.state.activeBudgetId === b.id ? (next.find((x) => !x.archived)?.id || null) : ctx.state.activeBudgetId, setupComplete: next.some((x) => !x.archived) });
            sheet.close();
          } },
        ),
      );
    },
  });
}

function renameBudget(ctx, id) {
  const target = (ctx.state.budgets || []).find((b) => b.id === (id || ctx.budget()?.id));
  if (!target) return;
  const input = textInput({ value: target.name, placeholder: "Budget name" });
  const err = h("div", { class: "set-budget-err" });
  const sheet = openSheet({
    title: "Rename Budget",
    closeLabel: "Discard",
    body: (host) => {
      const save = () => {
        const name = input.value.trim();
        err.textContent = "";
        if (!name) return;
        if (ctx.state.budgets.some((b) => b.id !== target.id && b.name.trim().toLowerCase() === name.toLowerCase())) {
          err.textContent = `A budget named "${name}" already exists. Choose a different name.`;
          return;
        }
        if (target.id === ctx.budget()?.id) ctx.updateBudget((b) => ({ ...b, name }));
        else ctx.commit({ ...ctx.state, budgets: ctx.state.budgets.map((b) => b.id === target.id ? { ...b, name } : b) });
        sheet.close();
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
      host.append(field("Budget Name", input), err, btnRow(
        { label: "Cancel", kind: "ghost", onClick: () => sheet.close() },
        { label: "Save", onClick: save },
      ));
      input.focus();
    },
  });
}

function newBudget(ctx) {
  const input = textInput({ placeholder: "e.g. Business Budget..." });
  let copyFrom = "";
  const err = h("div", { class: "set-budget-err" });
  const sheet = openSheet({
    title: "Create New Budget",
    closeLabel: "Discard",
    body: (host) => {
      const sel = h("select", { class: "input" }, h("option", { value: "", text: "Select a budget..." }));
      for (const b of (ctx.state.budgets || []).filter((x) => !x.archived)) sel.append(h("option", { value: b.id, text: b.name }));
      sel.addEventListener("change", () => { copyFrom = sel.value; sync(); });
      input.addEventListener("input", sync);
      const blank = btn("Start Completely Blank", { kind: "primary", block: true, disabled: true, onClick: () => create(true) });
      const copy = btn("Copy & Create", { kind: "good", block: true, disabled: true, onClick: () => create(false) });
      const sync = () => {
        const named = !!input.value.trim();
        blank.disabled = !named;
        copy.disabled = !named || !copyFrom;
      };
      const create = (blankStart) => {
        const name = input.value.trim();
        err.textContent = "";
        if (!name) return;
        if (ctx.state.budgets.some((b) => b.name.trim().toLowerCase() === name.toLowerCase())) {
          err.textContent = `A budget named "${name}" already exists. Choose a different name.`;
          return;
        }
        if (!blankStart && !copyFrom) return;
        let b = freshBudgetShell(name, ctx.state.activeUserId);
        if (!blankStart) {
          const source = (ctx.state.budgets || []).find((x) => x.id === copyFrom);
          if (source) {
            const copied = copyCategories(source);
            b = { ...b, categoryGroups: copied.groups, categories: copied.categories };
          }
        }
        ctx.addBudget(b);
        sheet.close();
      };
      host.append(
        field("Budget Name", input),
        err,
        blank,
        h("div", { class: "set-or", text: "— or —" }),
        field("Copy categories from", sel),
        copy,
      );
      input.focus();
    },
  });
}

function download(ctx) {
  const data = exportData(ctx.state);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `toozbudgeting-backup-${todayStampIso()}.json` });
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
    const parsed = JSON.parse(await navigator.clipboard.readText());
    if (!parsed || !Array.isArray(parsed.budgets)) { toast("Clipboard doesn't contain a valid ToozBudgeting backup."); return; }
    confirmRestore(ctx, parsed);
  } catch { toast("Couldn't read clipboard. Make sure you've copied a ToozBudgeting backup first."); }
}
function todayStampIso() {
  return new Date().toISOString().slice(0, 10);
}
function importFile(ctx, errEl) {
  const input = h("input", { type: "file", accept: "application/json,.json" });
  input.addEventListener("change", async () => {
    const f = input.files?.[0]; if (!f) return;
    if (errEl) errEl.textContent = "";
    try {
      const parsed = JSON.parse(await f.text());
      if (!parsed || !Array.isArray(parsed.budgets)) {
        if (errEl) errEl.textContent = "This doesn't look like a ToozBudgeting backup file.";
        else toast("This doesn't look like a ToozBudgeting backup file.");
        return;
      }
      confirmRestore(ctx, parsed);
    } catch {
      const msg = "Couldn't read that file — make sure it's a ToozBudgeting backup (.json).";
      if (errEl) errEl.textContent = msg;
      else toast(msg);
    }
  });
  input.click();
}

function confirmRestore(ctx, parsed) {
  let data;
  try { data = parsed.budgets ? importData(parsed) : parsed; }
  catch (e) { toast(e.message || "Couldn't import that file"); return; }
  const n = (data.budgets || parsed.budgets || []).length;
  const sheet = openSheet({
    title: "Restore from Backup?",
    body: (host) => {
      host.append(
        h("div", { class: "set-factory-warn", text: `This will replace everything currently in ToozBudgeting with this backup (${n} budget${n !== 1 ? "s" : ""}).` }),
        h("div", { class: "set-factory-note", text: "You can Undo right after if this wasn't what you meant to do." }),
        btnRow(
          { label: "Cancel", kind: "ghost", onClick: () => sheet.close() },
          { label: "Restore Backup", kind: "danger", onClick: () => { ctx.restore(data); sheet.close(); toast("Backup restored"); } },
        ),
      );
    },
  });
}

function factoryReset(ctx) {
  const signedIn = !!ctx.account?.token;
  const sheet = openSheet({
    title: "Factory Reset?",
    body: (host) => {
      host.append(
        h("div", { class: "set-factory-warn", text: signedIn
          ? "This signs this device out and erases the budgets on this device, then reopens the setup wizard. Your household’s budget stays safe on the server."
          : "This permanently erases everything in this copy of ToozBudgeting — all budgets, accounts, transactions, and settings — and reopens the setup wizard." }),
        h("div", { class: "set-factory-note", text: "This cannot be undone. Export a backup first (above) if you want to keep a copy." }),
        btnRow(
          { label: "Cancel", kind: "ghost", onClick: () => sheet.close() },
          { label: "Erase Everything", kind: "danger", onClick: () => { sheet.close(); ctx.reset(); } },
        ),
      );
    },
  });
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
