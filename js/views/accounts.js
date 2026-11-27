import { h, btn, openSheet, field, textInput, toast, moneyButton, confirmDialog } from "../ui.js?v=140";
import { fmt, todayKey, toTitleCase, isCard, monthKey, monthLabel, ccPayCat, round2 } from "../util.js?v=140";
import { accountBalances, available, globalFree, spentByMonthCat, ccMismatches, staleReconcile, findUnclearedSuggestion, txBalanceEffect } from "../calc.js?v=140";
import { addAccount, addCreditCard, renameAccount, archiveAccount, deleteAccount, reconcileAccount, addTransaction, isLocked, closeAccountBalance, finishAccountClose } from "../mutate.js?v=140";

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
      h("span", { text: `Owes ${fmt(m.owed)} · ${fmt(m.setAside)} set aside` }),
      h("span", { class: "notice-go", text: "Plan" }),
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
  root.append(banks, cards);
  root.append(h("nav", { class: "link-row" },
    h("button", { class: "text-link", type: "button", text: ctx.ui.showArchived ? "Hide archived" : "Archived", onclick: () => { ctx.ui.showArchived = !ctx.ui.showArchived; ctx.render(); } }),
  ));
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
      const hasTx = (budget.transactions || []).some((t) => t.accountId === a.id);
      if (a.archived) {
        host.append(btn("Restore", { block: true, kind: "ghost", onClick: () => { sheet.close(); requestAccountAction(ctx, a, card, "archive"); } }));
        if (!hasTx) host.append(btn("Delete", { kind: "danger", block: true, onClick: () => { sheet.close(); requestAccountAction(ctx, a, card, "delete"); } }));
      } else if (hasTx) {
        host.append(btn("Archive", { block: true, kind: "ghost", onClick: () => { sheet.close(); requestAccountAction(ctx, a, card, "archive"); } }));
      } else {
        host.append(btn("Delete", { kind: "danger", block: true, onClick: () => { sheet.close(); requestAccountAction(ctx, a, card, "delete"); } }));
      }
    },
  });
}

function requestAccountAction(ctx, account, card, action, skipReconcile) {
  const budget = ctx.budget();
  const a = [...(budget.accounts || []), ...(budget.creditCards || [])].find((x) => x.id === account.id) || account;
  if (a.archived && action === "archive") {
    ctx.updateBudget((b) => archiveAccount(b, a.id, card));
    toast("Restored");
    return;
  }
  const txs = (budget.transactions || []).filter((t) => t.accountId === a.id);
  const uncat = txs.filter((t) => t.type === "expense" && !t.splits && (!t.categoryId || t.categoryConfirmed === false));
  if (uncat.length) {
    const verb = action === "delete" ? "delete" : "archive";
    confirmDialog({
      title: `Cannot ${verb} ${a.name}`,
      message: `${uncat.length} transaction${uncat.length === 1 ? "" : "s"} ${uncat.length === 1 ? "is" : "are"} missing a category or still unconfirmed. Categorize them before you ${verb} it.`,
      confirm: "Review",
      onConfirm: () => ctx.go("transactions", { accountId: a.id, attention: true }),
    });
    return;
  }
  if (!txs.length && action === "delete") {
    confirmDialog({
      title: `Delete ${a.name}?`,
      message: "This cannot be undone. You can still undo it from the top bar until you leave.",
      confirm: "Delete",
      danger: true,
      onConfirm: () => {
        ctx.updateBudget((b) => deleteAccount(b, a.id, card));
        toast("Deleted", { label: "Undo", action: () => ctx.undo() });
      },
    });
    return;
  }
  if (action === "archive" && !skipReconcile) {
    const openTxs = txs.filter((t) => !t.reconciled);
    if (openTxs.length) {
      confirmDialog({
        title: "Reconcile first",
        message: `${a.name} still has unreconciled transactions. Reconcile before archiving.`,
        confirm: "Reconcile",
        onConfirm: () => openReconcile(ctx, a, card, accountBalances(budget)[a.id] || 0, () => requestAccountAction(ctx, a, card, action, true)),
      });
      return;
    }
  }
  const balance = accountBalances(ctx.budget())[a.id] || 0;
  if (card) {
    if (balance <= 0.005) {
      ctx.updateBudget((b) => archiveAccount(b, a.id, true));
      toast("Archived", { label: "Undo", action: () => ctx.undo() });
      return;
    }
    const pay = ccPayCat(ctx.budget(), a.id);
    const setAside = pay ? available(ctx.budget(), pay.id, monthKey()) : 0;
    if (setAside >= balance - 0.005) {
      ctx.updateBudget((b) => archiveAccount(b, a.id, true));
      toast("Archived", { label: "Undo", action: () => ctx.undo() });
      return;
    }
    const short = balance - Math.max(0, setAside);
    openSheet({
      title: `Cannot ${action === "delete" ? "delete" : "archive"} ${a.name}`,
      body: (host) => {
        host.append(h("p", { class: "lede", text: `${a.name} still has ${fmt(balance)} owed, but the payment category only has ${fmt(Math.max(0, setAside))} set aside. That’s ${fmt(short)} short.` }));
        host.append(h("p", { class: "hint", text: `Budget another ${fmt(short)} to the ${a.name} payment category, then pay the card off before you ${action === "delete" ? "delete" : "archive"} it.` }));
        host.append(btn("OK", { block: true, onClick: () => host.closest(".scrim")?.querySelector(".icon-btn")?.click() }));
      },
    });
    return;
  }
  if (Math.abs(balance) < 0.005) {
    ctx.updateBudget((b) => action === "delete" ? deleteAccount(b, a.id, false) : archiveAccount(b, a.id, false));
    toast(action === "delete" ? "Deleted" : "Archived", { label: "Undo", action: () => ctx.undo() });
    return;
  }
  if (balance < -0.005) {
    openOverdrawn(ctx, a, action, balance);
    return;
  }
  openBalanceResolution(ctx, a, action, balance);
}

function accountSources(budget) {
  const today = monthKey();
  const spent = spentByMonthCat(budget);
  const sources = [];
  const free = globalFree(budget, today);
  if (free > 0.005) sources.push({ key: "rta", label: "Ready to Assign", month: null, max: free });
  const months = [...new Set([today, ...Object.keys(budget.monthlyBudgets || {}).filter((mk) => mk >= today)])].sort().reverse();
  for (const mk of months) {
    for (const cat of budget.categories || []) {
      if (cat.archived || cat.creditCardId) continue;
      const budgeted = Number((budget.monthlyBudgets?.[mk] || {})[cat.id] || 0);
      const activity = spent[mk]?.[cat.id] || 0;
      const unspent = budgeted - activity;
      if (unspent > 0.005) sources.push({ key: `${mk}:${cat.id}`, label: cat.name, month: mk, max: unspent });
    }
  }
  return sources;
}

function openBalanceResolution(ctx, account, action, balance) {
  const absBalance = Math.abs(balance);
  const budget = ctx.budget();
  const sources = accountSources(budget);
  const picks = {};
  const others = (budget.accounts || []).filter((a) => a.id !== account.id && !a.archived);
  const verb = action === "delete" ? "Delete" : "Archive";
  const sheet = openSheet({
    title: `Free up funds to ${verb.toLowerCase()}`,
    body: (host) => {
      const paint = () => {
        const selected = Object.values(picks).reduce((s, n) => s + (Number(n) || 0), 0);
        const still = Math.max(0, absBalance - selected);
        const covered = still < 0.005;
        const pool = sources.reduce((s, src) => s + src.max, 0);
        host.replaceChildren(
          h("p", { class: "lede", text: `${account.name} · balance ${fmt(absBalance)}` }),
          h("p", { class: "hint", text: pool + 0.005 < absBalance
            ? "Tap a source to move it back to Ready to Assign. There isn’t enough here. Transfer the rest."
            : "Tap a source to move it back to Ready to Assign." }),
        );
        if (sources.length) {
          host.append(btn("Auto-fill", { kind: "ghost", onClick: () => {
            let left = absBalance;
            for (const key of Object.keys(picks)) delete picks[key];
            for (const src of sources) {
              if (left <= 0.005) break;
              const take = Math.min(src.max, left);
              picks[src.key] = round2(take);
              left = round2(left - take);
            }
            paint();
          }}));
        } else host.append(h("p", { class: "empty", text: "No unspent budgeted funds available." }));
        for (const src of sources) {
          const on = Object.prototype.hasOwnProperty.call(picks, src.key);
          host.append(h("label", { class: "line" },
            h("input", { type: "checkbox", checked: on, onchange: () => {
              if (on) delete picks[src.key];
              else {
                const used = Object.entries(picks).reduce((s, [k, n]) => s + (k === src.key ? 0 : Number(n) || 0), 0);
                picks[src.key] = round2(Math.min(src.max, Math.max(0, absBalance - used)));
              }
              paint();
            }}),
            h("span", { class: "grow", text: src.label }),
            h("span", { class: "muted", text: `${src.month ? monthLabel(src.month) : "Current"} · ${fmt(src.max)} unspent` }),
          ));
          if (on) {
            host.append(moneyButton(picks[src.key] || 0, (n) => {
              picks[src.key] = round2(Math.min(Math.max(0, n), src.max));
              paint();
            }, { label: src.label }));
          }
        }
        host.append(h("div", { class: "line" },
          h("span", { text: "Still needed" }),
          h("strong", { class: covered ? "money pos" : "money neg", text: covered ? "Fully covered" : fmt(still) }),
        ));
        const row = h("div", { class: "row gap wrap" });
        if (others.length) row.append(btn("Transfer", { kind: "ghost", onClick: () => {
          sheet.close();
          openTransfer(ctx, account.id, (bal) => {
            if (Math.abs(bal) < 0.005) {
              ctx.updateBudget((b) => finishAccountClose(b, account.id, action, false));
              toast(action === "delete" ? "Deleted" : "Archived", { label: "Undo", action: () => ctx.undo() });
            } else if (bal > 0.005) openBalanceResolution(ctx, account, action, bal);
            else openOverdrawn(ctx, account, action, bal);
          }, { amount: absBalance });
        }}));
        row.append(btn("Cancel", { kind: "quiet", onClick: () => sheet.close() }));
        row.append(btn(covered ? verb : "Commit", { disabled: selected < 0.005, onClick: () => {
          if (selected < 0.005) return;
          const list = Object.entries(picks).filter(([, n]) => n > 0.004).map(([key, amount]) => ({ key, amount }));
          const res = closeAccountBalance(ctx.budget(), { accountId: account.id, action, selections: list, absBalance });
          ctx.updateBudget(() => res.budget);
          sheet.close();
          if (res.covered) {
            toast(action === "delete" ? "Deleted" : "Archived", { label: "Undo", action: () => ctx.undo() });
            return;
          }
          openRemainder(ctx, account, action, res.remaining);
        }}));
        host.append(row);
      };
      paint();
    },
  });
}

function openRemainder(ctx, account, action, remaining) {
  const verb = action === "delete" ? "delete" : "archive";
  const others = (ctx.budget().accounts || []).some((a) => a.id !== account.id && !a.archived);
  openSheet({
    title: "Balance not fully covered",
    body: (host) => {
      host.append(h("p", { class: "lede", text: `${fmt(remaining)} is still on ${account.name}. Transfer it to another account to ${verb}.` }));
      host.append(h("p", { class: "hint", text: "What you already pulled has been moved. Cancel leaves the rest on the account." }));
      if (others) host.append(btn("Transfer the rest", { block: true, onClick: () => {
        host.closest(".scrim")?.querySelector(".icon-btn")?.click();
        openTransfer(ctx, account.id, (bal) => {
          if (Math.abs(bal) < 0.005) {
            ctx.updateBudget((b) => finishAccountClose(b, account.id, action, false));
            toast(action === "delete" ? "Deleted" : "Archived", { label: "Undo", action: () => ctx.undo() });
          } else if (bal > 0.005) openBalanceResolution(ctx, account, action, bal);
          else toast(`${account.name} is still overdrawn by ${fmt(Math.abs(bal))}.`);
        }, { amount: remaining });
      }}));
      host.append(btn(`Cancel ${verb}`, { kind: "quiet", block: true, onClick: () => host.closest(".scrim")?.querySelector(".icon-btn")?.click() }));
    },
  });
}

function openOverdrawn(ctx, account, action, balance) {
  const verb = action === "delete" ? "delete" : "archive";
  const need = Math.abs(balance);
  const others = (ctx.budget().accounts || []).filter((a) => a.id !== account.id && !a.archived);
  openSheet({
    title: `${account.name} is overdrawn`,
    body: (host) => {
      host.append(h("p", { class: "lede", text: `${account.name} is overdrawn by ${fmt(need)}. Add money until the balance is zero, then ${verb} it.` }));
      host.append(h("p", { class: "hint", text: "Categories can’t cover an overdraft. Transfer money in from another account, or record the deposit in Activity." }));
      if (others.length) {
        let fromId = others[0].id;
        const sel = h("select", { class: "input" });
        for (const a of others) sel.append(h("option", { value: a.id, text: a.name }));
        sel.addEventListener("change", () => { fromId = sel.value; });
        host.append(field("From", sel));
        host.append(btn("Transfer in", { block: true, onClick: () => {
          host.closest(".scrim")?.querySelector(".icon-btn")?.click();
          openTransfer(ctx, fromId, (bal) => {
            if (Math.abs(bal) < 0.005) {
              ctx.updateBudget((b) => finishAccountClose(b, account.id, action, false));
              toast(action === "delete" ? "Deleted" : "Archived", { label: "Undo", action: () => ctx.undo() });
            } else if (bal > 0.005) openBalanceResolution(ctx, account, action, bal);
            else openOverdrawn(ctx, account, action, bal);
          }, { amount: need, toId: account.id, watchId: account.id });
        }}));
      }
      host.append(btn("Cancel", { kind: "quiet", block: true, onClick: () => host.closest(".scrim")?.querySelector(".icon-btn")?.click() }));
    },
  });
}

function openTransfer(ctx, fromId, onDone, preset) {
  const budget = ctx.budget();
  const opts = preset && typeof preset === "object" ? preset : {};
  const watchId = opts.watchId || fromId;
  const fromBal = Math.max(0, accountBalances(budget)[fromId] || 0);
  let to = opts.toId || "";
  let amount = opts.amount != null ? round2(Math.min(Math.max(0, opts.amount), fromBal || opts.amount)) : (onDone ? fromBal : 0);
  const sheet = openSheet({
    title: "Transfer",
    body: (host) => {
      const sel = h("select", { class: "input" }, h("option", { value: "", text: "Select account" }));
      for (const a of [...budget.accounts, ...budget.creditCards]) if (!a.archived && a.id !== fromId) sel.append(h("option", { value: a.id, text: a.name }));
      if (to) sel.value = to;
      sel.addEventListener("change", () => { to = sel.value; });
      host.append(
        h("p", { class: "hint", text: `From ${[...budget.accounts, ...budget.creditCards].find((a) => a.id === fromId)?.name || "account"} · ${fmt(fromBal)} available` }),
        field("To", sel),
        field("Amount", moneyButton(amount, (n) => { amount = Math.abs(n); }, { label: "Amount" })),
        btn("Transfer", { block: true, onClick: () => {
          const cap = Math.max(0, accountBalances(ctx.budget())[fromId] || 0);
          if (!to || to === fromId) { toast("Pick a different account"); return; }
          if (!(amount > 0)) { toast("Enter an amount"); return; }
          if (amount > cap + 0.005) { toast(`Only ${fmt(cap)} can leave this account`); return; }
          const res = addTransaction(ctx.budget(), { type: "transfer", accountId: fromId, transferAccountId: to, amount, date: todayKey(), payee: "Transfer" });
          if (res.error) { toast(res.error); return; }
          ctx.updateBudget(() => res.budget);
          sheet.close();
          const watched = accountBalances(ctx.budget())[watchId] || 0;
          if (!onDone) toast("Transferred", { label: "Undo", action: () => ctx.undo() });
          onDone?.(watched);
        }}),
      );
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

