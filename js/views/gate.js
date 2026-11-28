import { h, field, textInput, btn, toast, devHooks, openAmountPad } from "../ui.js?v=154";
import { genUserId, guestSuffix, toTitleCase, uid, fmt, monthKey } from "../util.js?v=154";
import { DEFAULT_GROUPS, DEFAULT_CATS, finishWizard } from "../mutate.js?v=154";
import { importData } from "../store.js?v=154";
import { renderGoogleButton, inviteDetails, setPendingInvite, ROLE_LABEL } from "../account.js?v=154";

function logo(title = "ToozBudgeting") {
  return h("div", { class: "gate-brand" },
    h("img", { class: "gate-logo", src: "./icons/icon-192.png", alt: "", width: "64", height: "64" }),
    h("div", { class: "gate-title", text: title }),
  );
}

export function renderIdentity(root, ctx, { invite = null } = {}) {
  root.append(h("main", { class: "gate" },
    h("div", { class: "gate-inner" },
      logo(),
      h("div", { id: "gate-body" }),
    ),
  ));
  const body = document.getElementById("gate-body");
  if (invite) showInvite(body, ctx, invite.id);
  else showChoice(body, ctx);
}

/** Opened from an invite link: who invited you, then straight to Sign in with Google. */
function showInvite(host, ctx, id) {
  const card = h("div", { class: "invite-card" }, h("p", { class: "hint", text: "Checking your invite…" }));
  const gsi = h("div", { class: "gsi-host" });
  const err = h("p", { class: "error", text: ctx.signedOutReason || "" });
  host.replaceChildren(card, gsi, err,
    btn("Not now", { kind: "quiet", block: true, onClick: async () => { await setPendingInvite(null); ctx.pendingInvite = null; ctx.render(); } }),
  );
  inviteDetails(id).then(({ invite }) => {
    const who = invite.invitedBy || "A household owner";
    card.replaceChildren(
      h("p", { class: "kicker", text: "You’re invited" }),
      h("p", { class: "invite-who", text: `${who} invited you to join ${invite.household} as ${(ROLE_LABEL[invite.role] || invite.role).toLowerCase()}.` }),
      h("p", { class: "hint", text: `Sign in with Google using ${invite.emailHint}, the address the invite was sent to.` }),
    );
  }).catch((e) => {
    card.replaceChildren(h("p", { class: "error", text: e.message }), h("p", { class: "hint", text: "If you’re already in the household, you can still sign in with Google." }));
  });
  renderGoogleButton(gsi, {
    onSignedIn: (acct) => ctx.accountSignedIn(acct),
    onError: (m) => { err.textContent = m; },
  }).catch((e) => { err.textContent = e.message; });
}

/** Shown while a signed-in device downloads the household budget for the first time. */
export function renderLoading(root, text) {
  root.append(h("main", { class: "gate gate-loading" },
    h("div", { class: "gate-inner" },
      logo(),
      h("div", { class: "gate-load-text", text: text || "Loading…" }),
    ),
  ));
}

function showChoice(host, ctx) {
  const gsi = h("div", { class: "gsi-host" });
  const err = h("p", { class: "error", text: ctx.signedOutReason || "" });
  const local = h("div", { class: "gate-choice" });
  host.replaceChildren(
    h("p", { class: "gate-hint", text: "Sign in with Google to share one budget with your household on every device." }),
    gsi, err,
    h("p", { class: "gate-or", text: "or use it on this device only" }),
    local,
  );
  renderGoogleButton(gsi, {
    onSignedIn: (acct) => ctx.accountSignedIn(acct),
    onError: (m) => { err.textContent = m; },
  }).catch((e) => { err.textContent = e.message; });
  showLocal(local, ctx);
}

function showLocal(host, ctx) {
  host.replaceChildren(
    btn("Continue as Guest", { block: true, onClick: () => {
      const userId = genUserId();
      ctx.signIn({
        userId, displayName: `Guest-${guestSuffix(userId)}`, isGuest: true,
        email: "", passwordHash: "", createdAt: new Date().toISOString(),
      }, { create: true });
    }}),
    btn("Sign Up", { block: true, kind: "navy-out", onClick: () => showSignup(host, ctx) }),
    btn("Log In", { block: true, kind: "ghost", onClick: () => showLogin(host, ctx) }),
    h("p", { class: "gate-hint", text: "Guests and device accounts budget fully on this device only. Sign in with Google any time from Settings to start sharing." }),
    h("p", { class: "hint legal-links" }, h("a", { href: "./privacy.html", text: "Privacy" }), " · ", h("a", { href: "./terms.html", text: "Terms" })),
  );
}

function showSignup(host, ctx) {
  const name = textInput({ placeholder: "e.g. Mick", autocomplete: "name" });
  const email = textInput({ type: "email", placeholder: "you@example.com", autocomplete: "email" });
  const pass = textInput({ type: "password", placeholder: "At least 6 characters", autocomplete: "new-password" });
  const err = h("p", { class: "error", text: "" });
  host.replaceChildren(
    field("Display Name", name),
    field("Email", email),
    field("Password", pass),
    err,
    btn("Sign Up", { block: true, onClick: () => {
      const displayName = name.value.trim();
      const em = email.value.trim();
      if (!displayName) { err.textContent = "Please enter a display name."; return; }
      if (!em.includes("@")) { err.textContent = "Please enter a valid email."; return; }
      if ((pass.value || "").length < 6) { err.textContent = "Password must be at least 6 characters."; return; }
      if ((ctx.state.users || []).some((u) => u.email.toLowerCase() === em.toLowerCase())) {
        err.textContent = "That email already has an account on this device. Log in instead.";
        return;
      }
      ctx.signIn({
        userId: genUserId(), displayName, isGuest: false, email: em,
        passwordHash: pass.value, createdAt: new Date().toISOString(),
      }, { create: true });
    }}),
    btn("Back", { block: true, kind: "ghost", onClick: () => showLocal(host, ctx) }),
  );
  name.focus();
}

function showLogin(host, ctx) {
  const email = textInput({ type: "email", placeholder: "you@example.com", autocomplete: "username" });
  const pass = textInput({ type: "password", placeholder: "Password", autocomplete: "current-password" });
  const err = h("p", { class: "error", text: "" });
  host.replaceChildren(
    field("Email", email),
    field("Password", pass),
    err,
    btn("Log In", { block: true, onClick: () => {
      const em = email.value.trim().toLowerCase();
      const found = (ctx.state.users || []).find((u) => (u.email || "").toLowerCase() === em && u.passwordHash === pass.value);
      if (!found) {
        err.textContent = "No account on this device matches that email and password. Accounts only exist on the device that created them.";
        return;
      }
      ctx.signIn(found, { create: false });
    }}),
    btn("Back", { block: true, kind: "ghost", onClick: () => showLocal(host, ctx) }),
  );
  email.focus();
}

function isBackup(parsed) {
  return !!(parsed && (Array.isArray(parsed.budgets) || Array.isArray(parsed.data?.budgets)));
}

function uniqueName(base, existing) {
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let i = 2;
  while (taken.has(`${base} (${i})`.toLowerCase())) i += 1;
  return `${base} (${i})`;
}

function dupNames(list) {
  const counts = new Map();
  for (const item of list) {
    const n = (item.name || "").trim().toLowerCase();
    if (!n) continue;
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  return (item) => {
    const n = (item.name || "").trim().toLowerCase();
    return !!n && (counts.get(n) || 0) > 1;
  };
}

function amountInput(label, value, onCommit, placeholder = "0.00") {
  const open = () => openAmountPad({
    title: label,
    value: value ?? 0,
    onCommit,
  });
  const b = h("button", { type: "button", class: "money-btn" + (value == null ? " is-empty" : ""), onclick: open });
  b.textContent = value == null ? placeholder : fmt(value);
  return field(label, b);
}

function errBanner(text) {
  return h("div", { class: "wiz-err", text: "⚠️ " + text });
}

function tipBanner(html) {
  return h("div", { class: "wiz-tip", html });
}

export function renderWizard(root, ctx) {
  const steps = ["Welcome", "Accounts", "Credit Cards", "Categories", "Done!"];
  const draft = {
    step: 0,
    name: "My Budget",
    accounts: [],
    cards: [],
    groups: DEFAULT_GROUPS.map((g) => ({ ...g, id: uid() })),
    categories: [],
    seeded: null,
    accName: "",
    accType: "checking",
    accBal: null,
    accErr: "",
    ccName: "",
    ccBal: null,
    ccErr: "",
    importErr: "",
    focus: null,
  };
  draft.categories = DEFAULT_CATS.map((c) => {
    const g = DEFAULT_GROUPS.find((x) => x.id === c.groupId);
    const ng = draft.groups.find((x) => x.name === g.name);
    return { ...c, id: uid(), groupId: ng.id, rollover: c.rollover || "rollover", rolloverMax: c.rolloverMax || 0, goal: c.goal || null };
  });
  const presetGroups = () => DEFAULT_GROUPS.map((g) => ({ ...g, id: uid() }));
  const presetCats = (groups) => DEFAULT_CATS.map((c) => {
    const g = DEFAULT_GROUPS.find((x) => x.id === c.groupId);
    const ng = groups.find((x) => x.name === g.name);
    return { ...c, id: uid(), groupId: ng.id, rollover: c.rollover || "rollover", rolloverMax: c.rolloverMax || 0, goal: c.goal || null };
  });

  const shell = h("main", { class: "wiz" });
  root.append(shell);

  const addAcc = () => {
    if (!draft.accName.trim() || draft.accBal === null) return false;
    const name = toTitleCase(draft.accName.trim());
    if (draft.accounts.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      draft.accErr = `An account named "${name}" already exists. Choose a different name.`;
      paint();
      return false;
    }
    draft.accounts.push({ id: uid(), name, type: draft.accType, balance: draft.accBal });
    draft.accName = "";
    draft.accType = "checking";
    draft.accBal = null;
    draft.accErr = "";
    draft.focus = "acc-name";
    paint();
    return true;
  };

  const addCC = () => {
    if (!draft.ccName.trim() || draft.ccBal === null) return false;
    const name = toTitleCase(draft.ccName.trim());
    if (draft.cards.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      draft.ccErr = `A credit card named "${name}" already exists. Choose a different name.`;
      paint();
      return false;
    }
    draft.cards.push({ id: uid(), name, balance: draft.ccBal });
    draft.ccName = "";
    draft.ccBal = null;
    draft.ccErr = "";
    draft.focus = "cc-name";
    paint();
    return true;
  };

  const restoreBackup = (parsed, failFile) => {
    if (!isBackup(parsed)) {
      draft.importErr = failFile
        ? "This doesn't look like a ToozBudgeting backup file."
        : "Clipboard doesn't contain a valid ToozBudgeting backup.";
      paint();
      return;
    }
    try {
      ctx.restore(importData(parsed));
      toast("Backup restored");
    } catch (e) {
      draft.importErr = e.message || (failFile
        ? "Couldn't read that file — make sure it's a ToozBudgeting backup (.json)."
        : "Couldn't read clipboard. Make sure you've copied a ToozBudgeting backup first.");
      paint();
    }
  };

  const continueFrom = (step) => {
    if (step === 1) {
      const hasName = !!draft.accName.trim();
      const hasBal = draft.accBal !== null && draft.accBal > 0;
      const hasBalNull = draft.accBal === null;
      if (hasName && draft.accBal !== null) { if (addAcc()) { draft.step = 2; paint(); } return; }
      if (hasName && hasBalNull) { draft.accErr = "Enter a starting balance for this account, or clear the name field to skip adding it."; paint(); return; }
      if (!hasName && hasBal) { draft.accErr = "Enter a name for this account, or clear the balance field to skip adding it."; paint(); return; }
    }
    if (step === 2) {
      const hasName = !!draft.ccName.trim();
      const hasBal = draft.ccBal !== null && draft.ccBal > 0;
      const hasBalNull = draft.ccBal === null;
      if (hasName && draft.ccBal !== null) { if (addCC()) { draft.step = 3; paint(); } return; }
      if (hasName && hasBalNull) { draft.ccErr = "Enter a balance for this card (0 if none), or clear the name field to skip adding it."; paint(); return; }
      if (!hasName && hasBal) { draft.ccErr = "Enter a name for this card, or clear the balance field to skip adding it."; paint(); return; }
    }
    draft.step = step + 1;
    paint();
  };

  const welcome = (body) => {
    const name = textInput({ value: draft.name, placeholder: "e.g. Personal Budget..." });
    name.addEventListener("input", () => { draft.name = name.value; start.disabled = !draft.name.trim(); });
    const file = h("input", { type: "file", accept: "application/json,.json", hidden: true });
    file.addEventListener("change", async () => {
      const f = file.files?.[0]; if (!f) return;
      draft.importErr = "";
      try {
        restoreBackup(JSON.parse(await f.text()), true);
      } catch {
        draft.importErr = "Couldn't read that file — make sure it's a ToozBudgeting backup (.json).";
        paint();
      }
      file.value = "";
    });
    const start = btn("Get Started →", { block: true, disabled: !draft.name.trim(), onClick: () => { if (!draft.name.trim()) return; draft.step = 1; paint(); } });
    const tools = h("div", { class: "wiz-tools" });
    body.append(
      h("div", { class: "wiz-welcome" },
        h("img", { class: "wiz-hero-logo", src: "./icons/icon-192.png", alt: "", width: "64", height: "64" }),
        h("div", { class: "wiz-hero-title", text: "Welcome to ToozBudgeting" }),
        h("p", { class: "wiz-hero-lede", text: "A zero-based budgeting app that gives every dollar a job." }),
        field("Budget name", name),
        start,
        h("div", { class: "wiz-restore" },
          h("p", { class: "wiz-restore-h", text: "Already have a backup? Restore it instead." }),
          btn("📥 Restore from Backup File", { block: true, kind: "navy-out", onClick: () => file.click() }),
          file,
          draft.importErr ? h("p", { class: "error", text: draft.importErr }) : null,
          h("div", { class: "wiz-clip" },
            h("div", { class: "wiz-clip-h", text: "📱 Mobile: Paste from Clipboard" }),
            h("p", { class: "wiz-clip-p", text: "If file import doesn't work on your device, copy your backup JSON to the clipboard first, then tap below." }),
            btn("📋 Paste Backup from Clipboard", { block: true, kind: "amber-fill", onClick: async () => {
              draft.importErr = "";
              try {
                restoreBackup(JSON.parse(await navigator.clipboard.readText()), false);
              } catch {
                draft.importErr = "Couldn't read clipboard. Make sure you've copied a ToozBudgeting backup first.";
                paint();
              }
            }}),
          ),
        ),
        tools,
      ),
    );
    devHooks.wizardCard?.(tools, ctx);
  };

  const accounts = (body) => {
    const total = draft.accounts.reduce((s, a) => s + (Number(a.balance) || 0), 0);
    body.append(
      tipBanner("💡 Account balances will seed your <strong>Ready to Assign</strong> balance."),
    );
    for (const a of draft.accounts) {
      body.append(h("div", { class: "wiz-item" },
        h("div", {},
          h("div", { class: "wiz-item-name", text: a.name }),
          h("div", { class: "wiz-item-meta", text: `${a.type} · ${fmt(a.balance)}` }),
        ),
        h("button", { class: "wiz-x", type: "button", "aria-label": "Remove", text: "×", onclick: () => { draft.accounts = draft.accounts.filter((x) => x.id !== a.id); paint(); } }),
      ));
    }
    if (draft.accounts.length) {
      body.append(h("div", { class: "wiz-total", text: `Total: ${fmt(total)} → Ready to Assign` }));
    }
    const nm = textInput({ value: draft.accName, placeholder: "Chase Checking" });
    nm.dataset.focus = "acc-name";
    nm.addEventListener("input", () => { draft.accName = nm.value; draft.accErr = ""; addBtn.disabled = !draft.accName.trim() || draft.accBal === null; });
    nm.addEventListener("keydown", (e) => { if (e.key === "Enter" && draft.accName.trim() && draft.accBal !== null) addAcc(); });
    const type = h("select", { class: "input" },
      h("option", { value: "checking", text: "Checking" }),
      h("option", { value: "savings", text: "Savings" }),
      h("option", { value: "cash", text: "Cash" }),
    );
    type.value = draft.accType;
    type.addEventListener("change", () => { draft.accType = type.value; });
    const addBtn = btn("+ Add Account", { kind: "good", disabled: !draft.accName.trim() || draft.accBal === null, onClick: addAcc });
    addBtn.dataset.focus = "acc-add";
    body.append(
      h("div", { class: "wiz-form" },
        h("div", { class: "wiz-form-row" },
          field("Account Name", nm),
          field("Type", type),
        ),
        amountInput("Current Balance ($)", draft.accBal, (n) => {
          draft.accBal = n;
          draft.accErr = "";
          draft.focus = "acc-add";
          paint();
        }, "e.g. 1000"),
        addBtn,
      ),
    );
    if (draft.accErr) body.append(errBanner(draft.accErr));
  };

  const cards = (body) => {
    body.append(h("p", { class: "wiz-lede", text: "Existing balances will be reserved in your budget automatically." }));
    for (const c of draft.cards) {
      body.append(h("div", { class: "wiz-item" },
        h("div", {},
          h("div", { class: "wiz-item-name", text: c.name }),
          h("div", { class: "wiz-item-meta", text: c.balance > 0 ? `${fmt(c.balance)} owed` : "No existing balance" }),
        ),
        h("button", { class: "wiz-x", type: "button", "aria-label": "Remove", text: "×", onclick: () => { draft.cards = draft.cards.filter((x) => x.id !== c.id); paint(); } }),
      ));
    }
    const nm = textInput({ value: draft.ccName, placeholder: "Chase Visa, Amex Blue..." });
    nm.dataset.focus = "cc-name";
    nm.addEventListener("input", () => { draft.ccName = nm.value; draft.ccErr = ""; addBtn.disabled = !draft.ccName.trim() || draft.ccBal === null; });
    nm.addEventListener("keydown", (e) => { if (e.key === "Enter" && draft.ccName.trim() && draft.ccBal !== null) addCC(); });
    const addBtn = btn("+ Add Card", { kind: "good", disabled: !draft.ccName.trim() || draft.ccBal === null, onClick: addCC });
    addBtn.dataset.focus = "cc-add";
    body.append(
      h("div", { class: "wiz-form" },
        field("Card Name", nm),
        amountInput("Balance Owed ($)", draft.ccBal, (n) => {
          draft.ccBal = n;
          draft.ccErr = "";
          draft.focus = "cc-add";
          paint();
        }, "0.00"),
        addBtn,
      ),
    );
    if (draft.ccErr) body.append(errBanner(draft.ccErr));
    body.append(h("p", { class: "wiz-skip", text: "No credit cards? Skip this step." }));
  };

  const categories = (body) => {
    if (!draft.seeded) {
      body.append(
        h("p", { class: "wiz-lede", text: "You can start with a set of common budget categories and edit them, or build your own from a blank slate." }),
        h("div", { class: "wiz-choice" },
          btn("Use Suggested Categories", { block: true, onClick: () => { draft.groups = presetGroups(); draft.categories = presetCats(draft.groups); draft.seeded = "defaults"; paint(); } }),
          btn("Start From Scratch", { block: true, kind: "navy-out", onClick: () => { draft.groups = []; draft.categories = []; draft.seeded = "scratch"; paint(); } }),
          btn("Back", { block: true, kind: "ghost", onClick: () => { draft.step = 2; paint(); } }),
        ),
      );
      return;
    }
    const isDupCat = dupNames(draft.categories);
    const isDupGrp = dupNames(draft.groups);
    const hasDupCat = draft.categories.some(isDupCat);
    const hasDupGrp = draft.groups.some(isDupGrp);
    body.append(h("p", { class: "wiz-lede", text: "Edit names, set how leftover money rolls over, and set goals — all right here. Rename or delete groups, remove categories you don't need, or add your own." }));
    if (hasDupCat) body.append(errBanner("Some categories have the same name — fix the highlighted ones below before continuing. Category names must be unique."));
    if (hasDupGrp) body.append(errBanner("Some groups have the same name — fix the highlighted ones below before continuing. Group names must be unique."));
    for (const g of draft.groups) {
      const block = h("div", { class: "wiz-group" });
      const gn = textInput({ value: g.name });
      gn.classList.add("wiz-group-name");
      if (isDupGrp(g)) gn.classList.add("is-dup");
      gn.dataset.focus = "grp-" + g.id;
      gn.addEventListener("input", () => { g.name = gn.value; });
      gn.addEventListener("blur", () => { g.name = toTitleCase(gn.value.trim()) || g.name; draft.focus = "grp-" + g.id; paint(); });
      block.append(h("div", { class: "wiz-group-h" },
        gn,
        h("button", { class: "wiz-x", type: "button", title: "Delete group", "aria-label": "Delete group", text: "×", onclick: () => {
          draft.groups = draft.groups.filter((x) => x.id !== g.id);
          draft.categories = draft.categories.filter((c) => c.groupId !== g.id);
          paint();
        } }),
      ));
      if (isDupGrp(g)) block.append(h("div", { class: "wiz-dup-note", text: `A group named "${g.name.trim()}" already exists — names must be unique.` }));
      const cats = draft.categories.filter((c) => c.groupId === g.id);
      if (!cats.length) block.append(h("div", { class: "wiz-empty", text: "No categories — tap + Add Category below" }));
      for (const c of cats) {
        const row = h("div", { class: "wiz-cat" });
        const cn = textInput({ value: c.name, placeholder: "Category name" });
        if (isDupCat(c)) cn.classList.add("is-dup");
        cn.dataset.focus = "cat-" + c.id;
        cn.addEventListener("input", () => { c.name = cn.value; });
        cn.addEventListener("blur", () => { c.name = toTitleCase(cn.value.trim()) || c.name; draft.focus = "cat-" + c.id; paint(); });
        row.append(h("div", { class: "wiz-cat-name" },
          cn,
          h("button", { class: "wiz-x muted-x", type: "button", "aria-label": "Remove", text: "×", onclick: () => { draft.categories = draft.categories.filter((x) => x.id !== c.id); paint(); } }),
        ));
        if (isDupCat(c)) row.append(h("div", { class: "wiz-dup-note", text: `A category named "${c.name.trim()}" already exists — names must be unique.` }));
        const roll = h("select", { class: "input wiz-mini" },
          h("option", { value: "rollover", text: "↻ Roll Over" }),
          h("option", { value: "return", text: "↩ Return to RTA" }),
          h("option", { value: "max", text: "≤ Cap at Amount" }),
        );
        roll.value = c.rollover || "rollover";
        roll.addEventListener("change", () => { c.rollover = roll.value; paint(); });
        const goal = h("select", { class: "input wiz-mini" },
          h("option", { value: "", text: "No Goal" }),
          h("option", { value: "savings", text: "🎯 Savings Target" }),
          h("option", { value: "monthly", text: "📅 Monthly Funding" }),
          h("option", { value: "date", text: "🏁 Target by Date" }),
        );
        goal.value = c.goal?.type || "";
        goal.addEventListener("change", () => {
          const type = goal.value;
          if (!type) c.goal = null;
          else c.goal = { type, target: c.goal?.target || 0, ...(type === "date" ? { targetDate: c.goal?.targetDate || "" } : {}) };
          paint();
        });
        row.append(h("div", { class: "wiz-cat-opts" }, roll, goal));
        if (c.rollover === "max") {
          row.append(amountInput("Cap ($)", c.rolloverMax || null, (v) => { c.rolloverMax = v; paint(); }));
        }
        if (c.goal?.type === "savings") {
          row.append(amountInput("Savings Target ($)", c.goal.target || null, (v) => { c.goal = { ...c.goal, target: v }; paint(); }, "e.g. 1000"));
        }
        if (c.goal?.type === "monthly") {
          row.append(amountInput("Monthly Amount ($)", c.goal.target || null, (v) => { c.goal = { ...c.goal, target: v }; paint(); }, "e.g. 500"));
        }
        if (c.goal?.type === "date") {
          const month = h("input", { type: "month", class: "input", value: c.goal.targetDate || "", min: monthKey() });
          month.addEventListener("change", () => { c.goal = { ...c.goal, targetDate: month.value }; });
          row.append(h("div", { class: "wiz-form-row" },
            amountInput("Total Target ($)", c.goal.target || null, (v) => { c.goal = { ...c.goal, target: v }; paint(); }, "e.g. 3000"),
            field("Target Date", month),
          ));
        }
        block.append(row);
      }
      block.append(h("button", { type: "button", class: "wiz-add-cat", text: "+ Add Category", onclick: () => {
        draft.categories.push({
          id: uid(), groupId: g.id,
          name: uniqueName("New Category", draft.categories.map((x) => x.name)),
          rollover: "rollover", rolloverMax: 0, goal: null,
        });
        paint();
      } }));
      body.append(block);
    }
    body.append(btn("+ Add Group", { kind: "navy-out", block: true, onClick: () => {
      draft.groups.push({ id: uid(), name: uniqueName("New Group", draft.groups.map((x) => x.name)) });
      paint();
    } }));
  };

  const done = (body) => {
    const accN = draft.accounts.length;
    const ccN = draft.cards.length;
    const total = draft.accounts.reduce((s, a) => s + (Number(a.balance) || 0), 0);
    body.append(
      h("div", { class: "wiz-welcome" },
        h("div", { class: "wiz-hero-emoji", text: "🎉" }),
        h("div", { class: "wiz-hero-title", text: "You're all set!" }),
        h("p", { class: "wiz-hero-lede" },
          h("strong", { text: draft.name }),
          ` is ready. ${accN} account${accN !== 1 ? "s" : ""} · ${ccN} credit card${ccN !== 1 ? "s" : ""}`,
        ),
        accN > 0 ? tipBanner(`✓ <strong>${fmt(total)}</strong> added to Ready to Assign.`) : null,
        h("div", { class: "wiz-next", html: "<strong>First steps:</strong><br>1. Assign every dollar to a category<br>2. Long-press (or right-click) any category to set goals<br>3. Log spending as you go" }),
      ),
    );
  };

  const footer = () => {
    const step = draft.step;
    if (step === 0) return null;
    if (step === 3 && !draft.seeded) return null;
    const isDupCat = dupNames(draft.categories);
    const isDupGrp = dupNames(draft.groups);
    const blocked = step === 3 && (draft.categories.some(isDupCat) || draft.groups.some(isDupGrp));
    const row = h("div", { class: "wiz-foot" },
      btn("Back", { kind: "navy-out", onClick: () => { draft.step = step - 1; paint(); } }),
    );
    if (step < steps.length - 1) {
      row.append(btn("Continue →", { disabled: blocked, onClick: () => continueFrom(step) }));
    } else {
      row.append(btn("Open My Budget →", { kind: "good", onClick: () => {
        const budget = finishWizard({
          name: draft.name.trim() || "My Budget",
          accounts: draft.accounts,
          creditCards: draft.cards,
          groups: draft.groups,
          categories: draft.categories,
          ownerId: ctx.state.activeUserId,
        });
        ctx.finishSetup(budget);
      } }));
    }
    return row;
  };

  const paint = () => {
    const pct = (draft.step / (steps.length - 1)) * 100;
    const bar = h("div", { class: "wiz-bar" },
      h("div", { class: "wiz-steps" }, ...steps.map((s, i) => h("span", {
        class: i === draft.step ? "on" : i < draft.step ? "done" : "",
        text: s,
      }))),
      h("div", { class: "wiz-meter" }, h("i", { style: `width:${pct}%` })),
    );
    const body = h("div", { class: "wiz-body" });
    if (ctx.state?._testWizard) {
      body.append(h("div", { class: "wiz-test-strip", text: "🧪 Test mode — this creates 🧪 Test Budget. Your real budgets are not touched." }));
    }
    if (draft.step !== 0) body.append(h("div", { class: "wiz-h", text: steps[draft.step] }));
    const content = h("div", { class: "wiz-content" });
    body.append(content);
    const kids = [bar, body, footer()].filter(Boolean);
    shell.replaceChildren(...kids);
    if (draft.step === 0) welcome(content);
    else if (draft.step === 1) accounts(content);
    else if (draft.step === 2) cards(content);
    else if (draft.step === 3) categories(content);
    else done(content);
    const focus = draft.focus;
    draft.focus = null;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (focus) content.querySelector(`[data-focus="${focus}"]`)?.focus();
      else if (draft.step === 1) content.querySelector('[data-focus="acc-name"]')?.focus();
      else if (draft.step === 2) content.querySelector('[data-focus="cc-name"]')?.focus();
    }));
  };

  paint();
}
