import { h, btn, openSheet, field, textInput, toast, confirmDialog } from "../ui.js?v=154";
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
    pane.append(setSec("Budget",
      h("div", { class: "set-card" },
        line(budget?.name || "Budget", "Rename", () => renameBudget(ctx)),
        line("New budget", "Create", () => newBudget(ctx)),
        line("Accounts and cards", "Add", () => ctx.go("accounts")),
      ),
    ));
    const budgets = (ctx.state.budgets || []).filter((b) => !b.archived);
    const others = (ctx.state.budgets || []).filter((b) => b.archived);
    pane.append(setSec("Budgets",
      h("div", { class: "set-card" },
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
      ),
    ));
  }

  if (tab === "data") {
    pane.append(setSec("Backup",
      h("div", { class: "set-card" },
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
      ),
    ));
    pane.append(setSec("Bank sync", h("div", { class: "set-card set-bank" }, ...(await bankSection(ctx)))));
    if (ctx.ui.openBank) {
      ctx.ui.openBank = false;
      setTimeout(() => openBankSheet(ctx), 0);
    }
    pane.append(h("div", { class: "set-foot" },
      h("p", { class: "hint", text: `ToozBudgeting ${APP_VERSION}` }),
      h("p", { class: "hint legal-links" }, h("a", { href: "./privacy.html", text: "Privacy" }), " · ", h("a", { href: "./terms.html", text: "Terms" })),
      btn("What's new", { kind: "quiet", block: true, onClick: () => openWhatsNew() }),
    ));
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
