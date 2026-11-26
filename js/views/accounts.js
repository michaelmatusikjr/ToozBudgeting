import { h, btn, openSheet, field, textInput, toast, moneyButton, confirmDialog } from "../ui.js";
import { fmt, todayKey, toTitleCase, isCard } from "../util.js";
import { accountBalances, ccMismatches, staleReconcile } from "../calc.js";
import { addAccount, addCreditCard, renameAccount, archiveAccount, deleteAccount, reconcileAccount, addTransaction, isLocked } from "../mutate.js";

export function renderAccounts(root, ctx) {
  const budget = ctx.budget();
  const bal = accountBalances(budget);
  const month = ctx.month;
  root.append(h("header", { class: "view-head" }, h("h1", { text: "Accounts" }), btn("Add", { onClick: () => openAdd(ctx) })));
  const stale = staleReconcile(budget);
  if (stale.length) root.append(h("p", { class: "notice", text: `${stale.length} account${stale.length === 1 ? "" : "s"} not reconciled in 30+ days.` }));
  const mism = ccMismatches(budget, month);
  for (const m of mism) {
    root.append(h("button", { class: "notice", type: "button", onclick: () => ctx.go("budget") },
      h("strong", { text: m.card.name }),
      h("span", { text: `Owes ${fmt(m.owed)} but only ${fmt(m.setAside)} is set aside.` }),
    ));
  }
  const banks = h("section", { class: "group" }, h("h2", { text: "Cash and banks" }));
  let total = 0;
  for (const a of budget.accounts) {
    if (a.archived && !ctx.ui.showArchived) continue;
    total += bal[a.id] || 0;
    banks.append(accountLine(ctx, a, bal[a.id] || 0, false));
  }
  banks.append(h("p", { class: "group-foot", text: `Total ${fmt(total)}` }));
  const cards = h("section", { class: "group" }, h("h2", { text: "Credit cards" }));
  for (const c of budget.creditCards) {
    if (c.archived && !ctx.ui.showArchived) continue;
    cards.append(accountLine(ctx, c, bal[c.id] || 0, true));
  }
  root.append(banks, cards, btn(ctx.ui.showArchived ? "Hide archived" : "Show archived", { kind: "quiet", onClick: () => { ctx.ui.showArchived = !ctx.ui.showArchived; ctx.render(); } }));
  if (ctx.ui.focusAccount) {
    const id = ctx.ui.focusAccount;
    ctx.ui.focusAccount = null;
    const item = [...budget.accounts, ...budget.creditCards].find((a) => a.id === id);
    if (item) openAccount(ctx, item, isCard(budget, id));
  }
}

function accountLine(ctx, a, balance, card) {
  return h("button", { class: "line account", type: "button", onclick: () => openAccount(ctx, a, card) },
    h("span", {}, h("strong", { text: a.name }), h("span", { class: "muted", text: card ? "Credit card" : a.type })),
    h("span", { class: balance < -0.005 ? "bad" : "", text: card ? `${fmt(balance)} owed` : fmt(balance) }),
  );
}

function openAccount(ctx, a, card) {
  const budget = ctx.budget();
  const bal = accountBalances(budget)[a.id] || 0;
  const sheet = openSheet({
    title: a.name,
    body: (host) => {
      host.append(h("p", { class: "rta-num", text: card ? fmt(bal) : fmt(bal) }), h("p", { class: "muted", text: card ? "Balance owed" : "Cleared balance from transactions" }));
      host.append(btn("Transactions", { block: true, kind: "ghost", onClick: () => { sheet.close(); ctx.go("transactions", { accountId: a.id }); } }));
      host.append(btn("Reconcile", { block: true, onClick: () => { sheet.close(); openReconcile(ctx, a, card, bal); } }));
      if (!card) host.append(btn("Transfer", { block: true, kind: "ghost", onClick: () => { sheet.close(); openTransfer(ctx, a.id); } }));
      host.append(btn("Rename", { block: true, kind: "ghost", onClick: () => {
        const input = textInput({ value: a.name });
        const s2 = openSheet({ title: "Rename", body: (h2) => {
          h2.append(field("Name", input), btn("Save", { block: true, onClick: () => {
            const name = toTitleCase(input.value.trim());
            const list = card ? budget.creditCards : budget.accounts;
            if (list.some((x) => x.id !== a.id && x.name.toLowerCase() === name.toLowerCase())) { toast("That name is already used"); return; }
            ctx.updateBudget((b) => renameAccount(b, a.id, card, name));
            s2.close(); sheet.close();
          }}));
        }});
      }}));
      host.append(btn(a.archived ? "Restore" : "Archive", { block: true, kind: "ghost", onClick: () => { sheet.close(); requestArchive(ctx, a, card); } }));
    },
  });
}

function requestArchive(ctx, a, card) {
  const budget = ctx.budget();
  const txs = (budget.transactions || []).filter((t) => t.accountId === a.id);
  const uncat = txs.filter((t) => t.type === "expense" && !t.splits && (!t.categoryId || t.categoryConfirmed === false));
  if (uncat.length) {
    confirmDialog({ title: "Can’t archive yet", message: `${uncat.length} transaction${uncat.length === 1 ? "" : "s"} still need a category.`, confirm: "Review them", onConfirm: () => ctx.go("transactions", { accountId: a.id }) });
    return;
  }
  const openTxs = txs.filter((t) => !t.reconciled && !isLocked(budget, t));
  if (openTxs.length) {
    confirmDialog({
      title: "Reconcile first",
      message: `${a.name} still has unreconciled transactions. Reconcile before archiving.`,
      confirm: "Reconcile",
      onConfirm: () => openReconcile(ctx, a, card, accountBalances(budget)[a.id] || 0, () => ctx.updateBudget((b) => archiveAccount(b, a.id, card))),
    });
    return;
  }
  const bal = accountBalances(budget)[a.id] || 0;
  if (Math.abs(bal) > 0.005 && !card) {
    openBalanceResolution(ctx, a, card, bal);
    return;
  }
  ctx.updateBudget((b) => archiveAccount(b, a.id, card));
  toast(a.archived ? "Restored" : "Archived");
}

function openBalanceResolution(ctx, a, card, bal) {
  const sheet = openSheet({
    title: "Balance remaining",
    body: (host) => {
      host.append(h("p", { class: "lede", text: `${a.name} still has ${fmt(bal)}. Move it before archiving, or delete the account only if it has no spending.` }));
      host.append(btn("Transfer out", { block: true, onClick: () => { sheet.close(); openTransfer(ctx, a.id); } }));
      host.append(btn("Archive anyway", { kind: "danger", block: true, onClick: () => { ctx.updateBudget((b) => archiveAccount(b, a.id, card)); sheet.close(); } }));
    },
  });
}

function openTransfer(ctx, fromId) {
  const budget = ctx.budget();
  let to = "";
  let amount = 0;
  const sheet = openSheet({
    title: "Transfer",
    body: (host) => {
      const sel = h("select", { class: "input" }, h("option", { value: "", text: "Select account" }));
      for (const a of [...budget.accounts, ...budget.creditCards]) if (!a.archived && a.id !== fromId) sel.append(h("option", { value: a.id, text: a.name }));
      sel.addEventListener("change", () => { to = sel.value; });
      host.append(field("To", sel), field("Amount", moneyButton(0, (n) => { amount = n; })),
        btn("Transfer", { block: true, onClick: () => {
          const res = addTransaction(budget, { type: "transfer", accountId: fromId, transferAccountId: to, amount, date: todayKey(), payee: "Transfer" });
          if (res.error) { toast(res.error); return; }
          ctx.updateBudget(() => res.budget);
          sheet.close();
          toast("Transferred", { label: "Undo", action: () => ctx.undo() });
        }}));
    },
  });
}

function openReconcile(ctx, a, card, computed, after) {
  const budget = ctx.budget();
  const txs = (budget.transactions || []).filter((t) => t.accountId === a.id);
  const uncat = txs.filter((t) => t.type === "expense" && !t.splits && (!t.categoryId || t.categoryConfirmed === false));
  if (uncat.length) {
    confirmDialog({ title: "Can’t reconcile yet", message: `${uncat.length} transaction${uncat.length === 1 ? "" : "s"} need a category first.`, confirm: "Review", onConfirm: () => ctx.go("transactions", { accountId: a.id }) });
    return;
  }
  const unlocked = txs.filter((t) => !isLocked(budget, t));
  const checked = new Set(unlocked.map((t) => t.id));
  let date = todayKey();
  let real = Math.abs(computed);
  const sheet = openSheet({
    title: `Reconcile ${a.name}`,
    body: (host) => {
      const dateEl = h("input", { class: "input", type: "date", value: date, max: todayKey() });
      dateEl.addEventListener("change", () => { date = dateEl.value; });
      const diffEl = h("p", { class: "lede" });
      const list = h("div", { class: "tx-list" });
      const paint = () => {
        const unchecked = unlocked.filter((t) => !checked.has(t.id)).reduce((s, t) => s + Number(t.amount), 0);
        const adjusted = computed - unchecked;
        const diff = real - (card ? Math.abs(adjusted) : adjusted);
        const matches = Math.abs(diff) < 0.005;
        diffEl.textContent = matches ? "Matches." : `Difference ${fmt(diff)}`;
        list.replaceChildren();
        for (const tx of [...unlocked].sort((x, y) => y.date.localeCompare(x.date))) {
          list.append(h("label", { class: "line" },
            h("input", { type: "checkbox", checked: checked.has(tx.id), onchange: (e) => { if (e.target.checked) checked.add(tx.id); else checked.delete(tx.id); paint(); } }),
            h("span", { text: `${tx.date} ${tx.payee || ""}` }),
            h("span", { text: fmt(tx.amount) }),
          ));
        }
        host.querySelector("[data-finish]")?.toggleAttribute("disabled", !matches);
      };
      host.append(
        h("p", { class: "hint", text: `ToozBudgeting shows ${fmt(computed)}${card ? " owed" : ""}.` }),
        field("Statement date", dateEl),
        field(card ? "Actual balance owed" : "Actual balance", moneyButton(real, (n) => { real = n; paint(); })),
        diffEl,
        h("p", { class: "kicker", text: "Uncheck anything that hasn’t cleared" }),
        list,
      );
      const finish = btn("Finish reconciliation", { block: true, onClick: () => {
        const unchecked = unlocked.filter((t) => !checked.has(t.id)).reduce((s, t) => s + Number(t.amount), 0);
        const adjusted = computed - unchecked;
        const diff = real - (card ? Math.abs(adjusted) : adjusted);
        if (Math.abs(diff) > 0.005) { toast("Uncheck transactions or add an adjustment"); return; }
        ctx.updateBudget((b) => reconcileAccount(b, a.id, date, 0, null));
        sheet.close();
        toast("Reconciled");
        after?.();
      }});
      finish.dataset.finish = "1";
      const adjust = btn("Add adjustment and reconcile", { kind: "ghost", block: true, onClick: () => {
        const unchecked = unlocked.filter((t) => !checked.has(t.id)).reduce((s, t) => s + Number(t.amount), 0);
        const adjusted = computed - unchecked;
        const diff = real - (card ? Math.abs(adjusted) : adjusted);
        ctx.updateBudget((b) => reconcileAccount(b, a.id, date, diff, [...checked]));
        sheet.close();
        toast("Reconciled with adjustment", { label: "Undo", action: () => ctx.undo() });
        after?.();
      }});
      host.append(finish, adjust);
      paint();
    },
  });
}

function openAdd(ctx) {
  const sheet = openSheet({
    title: "Add",
    body: (host) => {
      host.append(
        btn("Bank or cash account", { block: true, onClick: () => { sheet.close(); openNewAccount(ctx, false); } }),
        btn("Credit card", { block: true, kind: "ghost", onClick: () => { sheet.close(); openNewAccount(ctx, true); } }),
      );
    },
  });
}

function openNewAccount(ctx, card) {
  let name = "";
  let type = "checking";
  let balance = 0;
  const sheet = openSheet({
    title: card ? "New card" : "New account",
    body: (host) => {
      const nm = textInput({ placeholder: card ? "Visa" : "Checking" });
      nm.addEventListener("input", () => { name = nm.value; });
      const typeSel = h("select", { class: "input" },
        h("option", { value: "checking", text: "Checking" }),
        h("option", { value: "savings", text: "Savings" }),
        h("option", { value: "cash", text: "Cash" }),
      );
      typeSel.addEventListener("change", () => { type = typeSel.value; });
      host.append(field("Name", nm));
      if (!card) host.append(field("Type", typeSel));
      host.append(field(card ? "Balance owed" : "Current balance", moneyButton(0, (n) => { balance = n; })));
      host.append(btn("Add", { block: true, onClick: () => {
        if (!name.trim()) return;
        ctx.updateBudget((b) => card ? addCreditCard(b, { name, balance }) : addAccount(b, { name, type, balance }));
        sheet.close();
        toast("Added. Starting balance is locked.");
      }}));
    },
  });
}

void deleteAccount;
