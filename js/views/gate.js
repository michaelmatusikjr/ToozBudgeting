import { h, field, textInput, btn, toast, moneyButton } from "../ui.js?v=140";
import { genUserId, guestSuffix, toTitleCase, uid } from "../util.js?v=140";
import { DEFAULT_GROUPS, DEFAULT_CATS, finishWizard } from "../mutate.js?v=140";
import { importData } from "../store.js?v=140";
import { renderGoogleButton } from "../account.js?v=140";

export function renderIdentity(root, ctx) {
  root.append(h("main", { class: "gate" },
    h("div", { class: "gate-card" },
      h("p", { class: "brand-mark", text: "Tooz" }),
      h("h1", { text: "Every dollar has a job." }),
      h("p", { class: "lede", text: "A calm, zero-based budget for your household." }),
      h("div", { id: "gate-body" }),
    ),
  ));
  showChoice(document.getElementById("gate-body"), ctx);
}

/** Shown while a signed-in device downloads the household budget for the first time. */
export function renderLoading(root, text) {
  root.append(h("main", { class: "gate" },
    h("div", { class: "gate-card" },
      h("p", { class: "brand-mark", text: "Tooz" }),
      h("h1", { text: "Getting your budget" }),
      h("p", { class: "lede", text: text || "Bringing in your household’s budget…" }),
    ),
  ));
}

function showChoice(host, ctx) {
  const gsi = h("div", { class: "gsi-host" });
  const err = h("p", { class: "error", text: ctx.signedOutReason || "" });
  host.replaceChildren(
    h("p", { class: "hint", text: "Sign in with Google to share one budget with your household on every device." }),
    gsi, err,
    h("p", { class: "gate-or", text: "or use it on this device only" }),
  );
  renderGoogleButton(gsi, {
    onSignedIn: (acct) => ctx.accountSignedIn(acct),
    onError: (m) => { err.textContent = m; },
  }).catch((e) => { err.textContent = e.message; });
  const local = h("div", {});
  host.append(local);
  showLocal(local, ctx);
}

function showLocal(host, ctx) {
  host.replaceChildren(
    btn("Continue as guest", { block: true, onClick: () => {
      const userId = genUserId();
      ctx.signIn({
        userId, displayName: `Guest-${guestSuffix(userId)}`, isGuest: true,
        email: "", passwordHash: "", createdAt: new Date().toISOString(),
      }, { create: true });
    }}),
    btn("Sign up", { block: true, kind: "ghost", onClick: () => showSignup(host, ctx) }),
    btn("Log in", { block: true, kind: "quiet", onClick: () => showLogin(host, ctx) }),
    h("p", { class: "hint", text: "Guests and device accounts budget fully on this device only. Sign in with Google any time from Settings to start sharing." }),
    h("p", { class: "hint legal-links" }, h("a", { href: "./privacy.html", text: "Privacy" }), " · ", h("a", { href: "./terms.html", text: "Terms" })),
  );
}

function showSignup(host, ctx) {
  const name = textInput({ placeholder: "Display name", autocomplete: "name" });
  const email = textInput({ type: "email", placeholder: "you@example.com", autocomplete: "email" });
  const pass = textInput({ type: "password", placeholder: "At least 6 characters", autocomplete: "new-password" });
  const err = h("p", { class: "error", text: "" });
  host.replaceChildren(
    field("Display name", name),
    field("Email", email),
    field("Password", pass),
    err,
    btn("Create account", { block: true, onClick: () => {
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
    btn("Back", { block: true, kind: "quiet", onClick: () => showLocal(host, ctx) }),
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
    btn("Log in", { block: true, onClick: () => {
      const em = email.value.trim().toLowerCase();
      const found = (ctx.state.users || []).find((u) => (u.email || "").toLowerCase() === em && u.passwordHash === pass.value);
      if (!found) {
        err.textContent = "No account on this device matches that email and password. Accounts only exist on the device that created them.";
        return;
      }
      ctx.signIn(found, { create: false });
    }}),
    btn("Back", { block: true, kind: "quiet", onClick: () => showLocal(host, ctx) }),
  );
  email.focus();
}

export function renderWizard(root, ctx) {
  const steps = ["Welcome", "Accounts", "Cards", "Categories", "Done"];
  const draft = {
    step: 0,
    name: "My Budget",
    accounts: [],
    cards: [],
    groups: DEFAULT_GROUPS.map((g) => ({ ...g, id: uid() })),
    categories: [],
    seeded: null,
  };
  draft.categories = DEFAULT_CATS.map((c) => {
    const g = DEFAULT_GROUPS.find((x) => x.id === c.groupId);
    const ng = draft.groups.find((x) => x.name === g.name);
    return { ...c, id: uid(), groupId: ng.id, rollover: "rollover" };
  });

  const shell = h("main", { class: "gate wizard" });
  root.append(shell);

  const paint = () => {
    const bar = h("div", { class: "steps" }, ...steps.map((s, i) => h("span", { class: i === draft.step ? "on" : i < draft.step ? "done" : "", text: s })));
    const body = h("div", { class: "gate-card" });
    shell.replaceChildren(bar, body);
    if (draft.step === 0) welcome(body);
    else if (draft.step === 1) accounts(body);
    else if (draft.step === 2) cards(body);
    else if (draft.step === 3) categories(body);
    else done(body);
    requestAnimationFrame(() => shell.querySelector(".steps .on")?.scrollIntoView({ inline: "center", block: "nearest" }));
  };

  const welcome = (body) => {
    const name = textInput({ value: draft.name });
    name.addEventListener("input", () => { draft.name = name.value; });
    const file = h("input", { type: "file", accept: "application/json,.json", hidden: true });
    file.addEventListener("change", async () => {
      const f = file.files?.[0]; if (!f) return;
      try {
        const parsed = JSON.parse(await f.text());
        ctx.restore(importData(parsed));
        toast("Backup restored");
      } catch (e) { toast(e.message || "Couldn’t read that file"); }
    });
    body.append(
      h("h1", { text: "Welcome" }),
      h("p", { class: "lede", text: "Name the budget. You can restore a backup instead of starting fresh." }),
      field("Budget name", name),
      btn("Get started", { block: true, onClick: () => { if (!draft.name.trim()) return; draft.step = 1; paint(); } }),
      h("div", { class: "divider" }),
      btn("Restore backup", { block: true, kind: "ghost", onClick: () => file.click() }),
      file,
      btn("Paste backup", { block: true, kind: "quiet", onClick: async () => {
        try {
          const text = await navigator.clipboard.readText();
          ctx.restore(importData(JSON.parse(text)));
          toast("Backup restored");
        } catch { toast("Clipboard doesn’t contain a valid backup"); }
      }}),
    );
  };

  const accounts = (body) => {
    const list = h("div", { class: "stack" });
    for (const a of draft.accounts) {
      list.append(h("div", { class: "line" },
        h("div", {}, h("strong", { text: a.name }), h("span", { class: "muted", text: ` ${a.type}` })),
        h("span", { text: "" }),
        h("button", { class: "icon-btn", type: "button", "aria-label": "Remove", text: "×", onclick: () => { draft.accounts = draft.accounts.filter((x) => x.id !== a.id); paint(); } }),
      ));
      list.lastChild.children[1].textContent = moneyText(a.balance);
    }
    const nm = textInput({ placeholder: "Chase Checking" });
    const type = h("select", { class: "input" },
      h("option", { value: "checking", text: "Checking" }),
      h("option", { value: "savings", text: "Savings" }),
      h("option", { value: "cash", text: "Cash" }),
    );
    let bal = null;
    const err = h("p", { class: "error", text: "" });
    const add = () => {
      const name = toTitleCase(nm.value.trim());
      if (!name || bal === null) { err.textContent = "Enter a name and a starting balance (0 is fine)."; return; }
      if (draft.accounts.some((a) => a.name.toLowerCase() === name.toLowerCase())) { err.textContent = `An account named “${name}” already exists.`; return; }
      draft.accounts.push({ id: uid(), name, type: type.value, balance: bal });
      paint();
    };
    body.append(
      h("h1", { text: "Accounts" }),
      h("p", { class: "lede", text: "Balances seed Ready to Assign. They become locked Starting Balance transactions." }),
      list,
      field("Account name", nm),
      field("Type", type),
      field("Current balance", moneyButton(0, (n) => { bal = n; })),
      err,
      btn("Add account", { kind: "ghost", onClick: add }),
      navRow(1, draft.accounts.length === 0),
    );
  };

  const cards = (body) => {
    const list = h("div", { class: "stack" });
    for (const c of draft.cards) {
      list.append(h("div", { class: "line" },
        h("strong", { text: c.name }),
        h("span", { class: "muted", text: c.balance > 0 ? "balance owed" : "no balance" }),
        h("button", { class: "icon-btn", type: "button", "aria-label": "Remove", text: "×", onclick: () => { draft.cards = draft.cards.filter((x) => x.id !== c.id); paint(); } }),
      ));
    }
    const nm = textInput({ placeholder: "Chase Visa" });
    let bal = null;
    const err = h("p", { class: "error", text: "" });
    body.append(
      h("h1", { text: "Credit cards" }),
      h("p", { class: "lede", text: "A positive balance is reserved in a payment category. Skip this if you have no cards." }),
      list,
      field("Card name", nm),
      field("Balance owed", moneyButton(0, (n) => { bal = n; })),
      err,
      btn("Add card", { kind: "ghost", onClick: () => {
        const name = toTitleCase(nm.value.trim());
        if (!name || bal === null) { err.textContent = "Enter a name and a balance (0 if none)."; return; }
        if (draft.cards.some((c) => c.name.toLowerCase() === name.toLowerCase())) { err.textContent = `A card named “${name}” already exists.`; return; }
        draft.cards.push({ id: uid(), name, balance: bal });
        paint();
      }}),
      navRow(2),
    );
  };

  const categories = (body) => {
    if (!draft.seeded) {
      body.append(
        h("h1", { text: "Categories" }),
        h("p", { class: "lede", text: "Start from common categories, or a blank slate." }),
        btn("Use suggested categories", { block: true, onClick: () => { draft.seeded = "defaults"; paint(); } }),
        btn("Start from scratch", { block: true, kind: "ghost", onClick: () => { draft.groups = []; draft.categories = []; draft.seeded = "scratch"; paint(); } }),
        btn("Back", { block: true, kind: "quiet", onClick: () => { draft.step = 2; paint(); } }),
      );
      return;
    }
    const list = h("div", { class: "stack" });
    for (const g of draft.groups) {
      const block = h("section", { class: "group" });
      const gn = textInput({ value: g.name });
      gn.addEventListener("change", () => { g.name = toTitleCase(gn.value.trim()) || g.name; });
      block.append(h("div", { class: "line" }, gn, h("button", { class: "icon-btn", type: "button", "aria-label": "Delete group", text: "×", onclick: () => {
        draft.groups = draft.groups.filter((x) => x.id !== g.id);
        draft.categories = draft.categories.filter((c) => c.groupId !== g.id);
        paint();
      } })));
      for (const c of draft.categories.filter((c) => c.groupId === g.id)) {
        const cn = textInput({ value: c.name });
        cn.addEventListener("change", () => { c.name = toTitleCase(cn.value.trim()) || c.name; });
        const roll = h("select", { class: "input" },
          h("option", { value: "rollover", text: "Roll over" }),
          h("option", { value: "return", text: "Return to Ready to Assign" }),
          h("option", { value: "max", text: "Cap" }),
        );
        roll.value = c.rollover || "rollover";
        roll.addEventListener("change", () => { c.rollover = roll.value; });
        block.append(h("div", { class: "cat-edit" }, cn, roll, h("button", { class: "icon-btn", type: "button", "aria-label": "Remove", text: "×", onclick: () => { draft.categories = draft.categories.filter((x) => x.id !== c.id); paint(); } })));
      }
      block.append(btn("Add category", { kind: "quiet", onClick: () => {
        draft.categories.push({ id: uid(), groupId: g.id, name: "New category", rollover: "rollover" });
        paint();
      }}));
      list.append(block);
    }
    const names = draft.categories.map((c) => c.name.trim().toLowerCase()).filter(Boolean);
    const dup = names.some((n, i) => names.indexOf(n) !== i);
    body.append(
      h("h1", { text: "Categories" }),
      dup ? h("p", { class: "error", text: "Category names must be unique." }) : null,
      list,
      btn("Add group", { kind: "ghost", onClick: () => { draft.groups.push({ id: uid(), name: "New group" }); paint(); } }),
      navRow(3, dup),
    );
  };

  const done = (body) => {
    body.append(
      h("h1", { text: "You’re set" }),
      h("p", { class: "lede", text: `${draft.name} · ${draft.accounts.length} accounts · ${draft.cards.length} cards` }),
      h("p", { text: "Assign every dollar, then log spending as it happens." }),
      btn("Open my budget", { block: true, onClick: () => {
        const budget = finishWizard({
          name: draft.name.trim() || "My Budget",
          accounts: draft.accounts,
          creditCards: draft.cards,
          groups: draft.groups,
          categories: draft.categories,
          ownerId: ctx.state.activeUserId,
        });
        ctx.finishSetup(budget);
      }}),
      btn("Back", { kind: "quiet", onClick: () => { draft.step = 3; paint(); } }),
    );
  };

  const navRow = (step, blocked) => h("div", { class: "row gap" },
    btn("Back", { kind: "ghost", onClick: () => { draft.step = step - 1; paint(); } }),
    btn("Continue", { disabled: !!blocked, onClick: () => { draft.step = step + 1; paint(); } }),
  );

  paint();
}

function moneyText(n) {
  const v = Number(n) || 0;
  return (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
