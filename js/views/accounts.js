import { h, btn, openSheet, field, textInput, toast, moneyButton, confirmDialog } from "../ui.js?v=120";
import { fmt, todayKey, toTitleCase, isCard } from "../util.js?v=120";
import { accountBalances, ccMismatches, staleReconcile, findUnclearedSuggestion, txBalanceEffect } from "../calc.js?v=120";
import { addAccount, addCreditCard, renameAccount, archiveAccount, deleteAccount, reconcileAccount, addTransaction, isLocked, zeroAccountByUnassign } from "../mutate.js?v=120";

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
    h("span", { class: balance < -0.005 ? "neg" : balance > 0.005 ? "pos" : "", text: card ? `${fmt(balance)} owed` : fmt(balance) }),
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
      host.append(btn("Delete", { kind: "danger", block: true, onClick: () => {
        const txs = (budget.transactions || []).filter((t) => t.accountId === a.id && t.subtype !== "starting_balance");
        if (txs.length) { toast("Delete isn’t available while this account has transactions. Archive it instead."); return; }
        confirmDialog({ title: `Delete ${a.name}?`, message: "The starting balance goes with it.", confirm: "Delete", danger: true, onConfirm: () => {
          ctx.updateBudget((b) => deleteAccount(b, a.id, card));
          sheet.close();
          toast("Deleted", { label: "Undo", action: () => ctx.undo() });
        } });
      }}));
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
      host.append(btn("Unassign categories to zero it", { kind: "ghost", block: true, onClick: () => { sheet.close(); openClawbackClose(ctx, a, bal); } }));
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
    confirmDialog({ title: "Can’t reconcile yet", message: `${uncat.length} transaction${uncat.length === 1 ? "" : "s"} need a category first.`, confirm: "Review", onConfirm: () => ctx.go("transactions", { accountId: a.id, attention: true }) });
    return;
  }
  const unlocked = txs.filter((t) => !isLocked(budget, t));
  const effect = (tx) => txBalanceEffect(tx, card);
  const checked = new Set(unlocked.map((t) => t.id));
  let date = todayKey();
  let real = computed;
  const sheet = openSheet({
    title: `Reconcile ${a.name}`,
    body: (host) => {
      const dateEl = h("input", { class: "input", type: "date", value: date, max: todayKey() });
      dateEl.addEventListener("change", () => { date = dateEl.value; });
      const diffEl = h("p", { class: "lede" });
      const note = h("p", { class: "hint", text: "" });
      const list = h("div", { class: "tx-list" });
      const figures = () => {
        const uncheckedSum = unlocked.filter((t) => !checked.has(t.id)).reduce((s, t) => s + effect(t), 0);
        const adjusted = computed - uncheckedSum;
        const diff = real - adjusted;
        return { uncheckedSum, adjusted, diff, matches: Math.abs(diff) < 0.005 };
      };
      const paint = () => {
        const { adjusted, diff, matches, uncheckedSum } = figures();
        diffEl.textContent = matches ? "Matches." : `Difference ${fmt(diff)}`;
        if (note.dataset.suggest) note.textContent = note.dataset.suggest;
        else if (Math.abs(uncheckedSum) > 0.005) note.textContent = `Cleared balance ${fmt(adjusted)}.`;
        else note.textContent = "";
        list.replaceChildren();
        for (const tx of [...unlocked].sort((x, y) => y.date.localeCompare(x.date))) {
          list.append(h("label", { class: "line" },
            h("input", { type: "checkbox", checked: checked.has(tx.id), onchange: (e) => { if (e.target.checked) checked.add(tx.id); else checked.delete(tx.id); note.dataset.suggest = ""; paint(); } }),
            h("span", { class: "grow", text: `${tx.payee || "—"} · ${tx.date}` }),
            h("span", { class: effect(tx) < -0.005 ? "neg" : effect(tx) > 0.005 ? "pos" : "", text: fmt(effect(tx)) }),
          ));
        }
        host.querySelector("[data-finish]")?.toggleAttribute("disabled", !matches);
        host.querySelector("[data-adjust]")?.toggleAttribute("disabled", matches);
      };
      const onReal = (n) => {
        real = n;
        const gap = real - computed;
        checked.clear();
        unlocked.forEach((t) => checked.add(t.id));
        note.dataset.suggest = "";
        if (Math.abs(gap) >= 0.005) {
          const suggestion = findUnclearedSuggestion(unlocked.map((t) => ({ ...t, amount: effect(t) })), gap);
          if (suggestion?.length) {
            suggestion.forEach((id) => checked.delete(id));
            note.dataset.suggest = `${suggestion.length} transaction${suggestion.length === 1 ? "" : "s"} unchecked to match that balance. Check them again if that’s wrong.`;
          }
        }
        paint();
      };
      const finish = btn("Finish reconciliation", { block: true, onClick: () => {
        const { matches } = figures();
        if (!matches) { toast("Uncheck transactions that haven’t cleared, or add an adjustment"); return; }
        ctx.updateBudget((b) => reconcileAccount(b, a.id, date, 0, [...checked]));
        sheet.close();
        toast("Reconciled");
        after?.();
      }});
      const adjust = btn("Add adjustment and reconcile", { kind: "ghost", block: true, onClick: () => {
        const { diff } = figures();
        ctx.updateBudget((b) => reconcileAccount(b, a.id, date, diff, [...checked]));
        sheet.close();
        toast("Reconciled with adjustment", { label: "Undo", action: () => ctx.undo() });
        after?.();
      }});
      finish.dataset.finish = "1";
      adjust.dataset.adjust = "1";
      host.append(
        h("p", { class: "hint", text: `ToozBudgeting shows ${fmt(computed)}${card ? " owed" : ""}. Uncheck anything that hasn’t cleared.` }),
        field("Statement date", dateEl),
        field(card ? "Actual balance owed" : "Actual balance", moneyButton(real, (n) => onReal(n), { allowNegative: !card, label: "Statement balance" })),
        diffEl,
        note,
        finish,
        adjust,
        h("p", { class: "kicker", text: "Not yet cleared" }),
        list,
      );
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

function openClawbackClose(ctx, account, bal) {
  const budget = ctx.budget();
  const month = ctx.month;
  const pulls = {};
  const sheet = openSheet({
    title: "Zero the account",
    body: (host) => {
      host.append(h("p", { class: "lede", text: `${account.name} has ${fmt(bal)}. Unassign that much from categories, then the account is adjusted to zero and archived.` }));
      for (const c of budget.categories) {
        if (c.archived || c.creditCardId) continue;
        const av = accountBalances ? (budget.monthlyBudgets?.[month]?.[c.id] || 0) : 0;
        if (av <= 0.005 && (budget.monthlyBudgets?.[month]?.[c.id] || 0) <= 0) continue;
        const assigned = Number((budget.monthlyBudgets?.[month] || {})[c.id] || 0);
        if (assigned <= 0.005) continue;
        host.append(h("div", { class: "line" }, h("span", { text: `${c.name} (${fmt(assigned)})` }), moneyButton(0, (n) => { pulls[c.id] = Math.min(n, assigned); })));
      }
      host.append(btn("Zero and archive", { block: true, onClick: () => {
        const list = Object.entries(pulls).filter(([, n]) => n > 0).map(([id, amount]) => ({ id, amount }));
        const sum = list.reduce((s, p) => s + p.amount, 0);
        if (Math.abs(sum - bal) > 0.05) { toast(`Unassign ${fmt(bal)} in total. That’s ${fmt(sum)} so far.`); return; }
        ctx.updateBudget((b) => archiveAccount(zeroAccountByUnassign(b, account.id, month, list), account.id, false));
        sheet.close();
        toast("Account archived", { label: "Undo", action: () => ctx.undo() });
      }}));
    },
  });
}

void isCard;
