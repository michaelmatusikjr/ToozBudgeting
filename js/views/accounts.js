import { h, btn, openSheet, field, textInput, toast, moneyButton, confirmDialog, bindContextMenu, amountInput, btnRow, searchableSel, append, clear } from "../ui.js?v=154";
import { fmt, todayKey, toTitleCase, isCard, monthKey, monthLabel, ccPayCat, round2 } from "../util.js?v=154";
import { accountBalances, available, globalFree, spentByMonthCat, findUnclearedSuggestion, txBalanceEffect, lastReconciledDate, daysSince } from "../calc.js?v=154";
import { addAccount, addCreditCard, renameAccount, archiveAccount, deleteAccount, reconcileAccount, addTransaction, isLocked, closeAccountBalance, finishAccountClose } from "../mutate.js?v=154";

export function renderAccounts(root, ctx) {
  const budget = ctx.budget();
  const bal = accountBalances(budget);
  const ro = !!ctx.readOnly();
  const cash = (budget.accounts || []).filter((a) => !a.archived);
  const cards = (budget.creditCards || []).filter((c) => !c.archived);
  const archived = [
    ...(budget.accounts || []).filter((a) => a.archived).map((a) => ({ ...a, isCard: false })),
    ...(budget.creditCards || []).filter((c) => c.archived).map((c) => ({ ...c, isCard: true })),
  ];
  const totalCash = cash.reduce((s, a) => s + (bal[a.id] || 0), 0);

  const view = h("div", { class: "acc-view" });
  if (cash.length) {
    view.append(h("div", { class: "acc-total" },
      h("div", { class: "acc-total-label", text: "Total Cash Balance" }),
      h("div", { class: "acc-total-amt", text: fmt(totalCash) }),
    ));
  }

  view.append(sectionHeader("🏦 Checking · Savings · Cash", ro ? null : () => openNewAccount(ctx, false), "+ Add Account"));
  if (!cash.length) view.append(h("div", { class: "acc-empty", text: "No accounts yet" }));
  else {
    const list = h("div", { class: "acc-list" });
    cash.forEach((a, i) => list.append(accountRow(ctx, a, bal[a.id] || 0, false, i === cash.length - 1)));
    view.append(list);
  }

  view.append(sectionHeader("💳 Credit Cards", ro ? null : () => openNewAccount(ctx, true), "+ Add Card"));
  if (!cards.length) view.append(h("div", { class: "acc-empty", text: "No cards yet" }));
  else {
    const list = h("div", { class: "acc-list" });
    cards.forEach((c, i) => list.append(accountRow(ctx, c, bal[c.id] || 0, true, i === cards.length - 1)));
    view.append(list);
  }

  if (archived.length) {
    const open = !!ctx.ui.showArchived;
    const wrap = h("div", { class: "acc-archived" });
    wrap.append(h("button", {
      class: "acc-archived-toggle", type: "button",
      onclick: () => { ctx.ui.showArchived = !open; ctx.render(); },
    },
      h("span", { class: "acc-archived-label", text: `🗂 Archived (${archived.length})` }),
      h("span", { class: "acc-archived-chev", text: open ? "▲" : "▼" }),
    ));
    if (open) {
      const list = h("div", { class: "acc-list acc-list-archived" });
      archived.forEach((item, i) => list.append(archivedRow(ctx, item, i === archived.length - 1)));
      wrap.append(list);
    }
    view.append(wrap);
  }

  root.append(view);

  if (ctx.ui.focusAccount) {
    const id = ctx.ui.focusAccount;
    ctx.ui.focusAccount = null;
    const item = [...(budget.accounts || []), ...(budget.creditCards || [])].find((a) => a.id === id);
    if (item) openReconcile(ctx, item, isCard(budget, id), bal[id] || 0);
  }
}

function sectionHeader(label, onAdd, addLabel) {
  return h("div", { class: "acc-sec-head" },
    h("div", { class: "acc-sec-label", text: label }),
    onAdd ? btn(addLabel, { kind: "primary small", onClick: onAdd }) : null,
  );
}

function accountMenuItems(ctx, a, card) {
  const budget = ctx.budget();
  const items = [
    { label: "📊 View Transactions", onClick: () => ctx.go("transactions", { accountId: a.id }) },
    { label: "⚖️ Reconcile", edit: true, onClick: () => openReconcile(ctx, a, card, accountBalances(budget)[a.id] || 0) },
  ];
  if (!card) items.push({ label: "💸 Transfer Money", edit: true, onClick: () => openTransfer(ctx, a.id) });
  items.push(
    { label: "✏️ Rename", edit: true, onClick: () => openRename(ctx, a, card) },
    { label: "🗂 Archive", edit: true, onClick: () => requestAccountAction(ctx, a, card, "archive") },
    { label: "🗑 Delete", danger: true, edit: true, onClick: () => requestAccountAction(ctx, a, card, "delete") },
  );
  return items;
}

function accountRow(ctx, a, balance, card, last) {
  const budget = ctx.budget();
  const recDate = lastReconciledDate(budget, a.id);
  const recLabel = recDate ? `✅ ${daysSince(recDate)}d ago` : "Never reconciled";
  const row = h("div", { class: `acc-row${last ? " last" : ""}`, tabindex: "0" });
  const meta = h("div", { class: "acc-meta" });
  if (!card) {
    meta.append(
      h("span", { class: "acc-type", text: a.type || "Account" }),
      h("span", { text: " · " }),
      h("span", { class: recDate ? "acc-rec ok" : "acc-rec", text: recLabel }),
    );
  } else {
    meta.append(
      h("span", { class: recDate ? "acc-rec ok" : "acc-rec", text: recLabel }),
      h("span", { text: " · " }),
      h("span", { class: balance > 0 ? "acc-owed" : "acc-paid", text: balance > 0 ? `${fmt(balance)} owed` : "Paid off" }),
    );
  }
  const amt = h("button", {
    class: `acc-bal${card && balance > 0 ? " owed" : card ? " paid" : ""}`,
    type: "button",
    text: card ? (balance > 0 ? `-${fmt(balance)}` : "$0.00") : fmt(balance),
    onclick: (e) => { e.stopPropagation(); ctx.go("transactions", { accountId: a.id }); },
  });
  row.append(h("div", { class: "acc-main" }, h("div", { class: "acc-name", text: a.name }), meta), amt);
  bindContextMenu(row, () => accountMenuItems(ctx, a, card), { readOnly: !!ctx.readOnly() });
  return row;
}

function archivedRow(ctx, item, last) {
  const hasTx = ((ctx.budget().transactions || []).some((t) => t.accountId === item.id));
  const row = h("div", { class: `acc-row acc-row-archived${last ? " last" : ""}`, tabindex: "0" });
  row.append(h("div", { class: "acc-main" },
    h("div", { class: "acc-name", text: item.name }),
    h("div", { class: "acc-meta" }, h("span", { class: "acc-type", text: item.isCard ? "Credit Card" : (item.type || "Account") })),
  ));
  bindContextMenu(row, () => [
    { label: "↩ Restore", edit: true, onClick: () => requestAccountAction(ctx, item, item.isCard, "archive") },
    ...(!hasTx ? [{ label: "🗑 Delete", danger: true, edit: true, onClick: () => requestAccountAction(ctx, item, item.isCard, "delete") }] : []),
  ], { readOnly: !!ctx.readOnly() });
  return row;
}

function openRename(ctx, a, card) {
  const budget = ctx.budget();
  const input = textInput({ value: a.name });
  input.setAttribute("autofocus", "");
  const err = h("div", { class: "acc-form-err" });
  const save = () => {
    const name = input.value.trim();
    err.textContent = "";
    if (!name) { err.textContent = "Name is required."; return; }
    const list = card ? budget.creditCards : budget.accounts;
    if (list.some((x) => x.id !== a.id && x.name.toLowerCase() === name.toLowerCase())) {
      err.textContent = `"${name}" already exists.`;
      return;
    }
    ctx.updateBudget((b) => renameAccount(b, a.id, card, name));
    sheet.close();
  };
  input.addEventListener("input", () => { err.textContent = ""; });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
  const sheet = openSheet({
    title: `Rename ${card ? "Card" : "Account"}`,
    closeLabel: "Discard",
    body: (host) => {
      host.append(
        field("Name", input),
        err,
        btnRow({ label: "Cancel", kind: "ghost", onClick: () => sheet.close() }, { label: "Save", onClick: save }),
      );
      input.focus();
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
    const actionLabel = action === "delete" ? "Delete" : "Archive";
    const count = uncat.length;
    const sheet = openSheet({
      title: `Cannot ${actionLabel} "${a.name}"`,
      body: (host) => {
        const who = count !== 1 ? "are" : "is";
        host.append(
          h("p", { class: "acc-modal-lede" },
            h("strong", { text: `${count} transaction${count !== 1 ? "s" : ""}` }),
            h("span", { text: ` on this account ${who} missing a category or have an unconfirmed category. All transactions must be categorized and confirmed before you can ${actionLabel.toLowerCase()} it.` }),
          ),
          btnRow(
            { label: "Cancel", kind: "ghost", onClick: () => sheet.close() },
            { label: "Review Transactions", onClick: () => { sheet.close(); ctx.go("transactions", { accountId: a.id, attention: true }); } },
          ),
        );
      },
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
      openReconcile(ctx, a, card, accountBalances(budget)[a.id] || 0, () => requestAccountAction(ctx, a, card, action, true));
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
    const actionLabel = action === "delete" ? "Delete" : "Archive";
    const setAsideAmt = Math.max(0, setAside);
    const sheet = openSheet({
      title: `Cannot ${actionLabel} "${a.name}"`,
      body: (host) => {
        host.append(
          h("p", { class: "acc-modal-lede" },
            h("strong", { text: a.name }),
            h("span", { text: " still has " }),
            h("strong", { class: "acc-err-amt", text: fmt(balance) }),
            h("span", { text: " owed, but your payment category only has " }),
            h("strong", { class: "acc-err-amt", text: fmt(setAsideAmt) }),
            h("span", { text: " set aside — a shortfall of " }),
            h("strong", { class: "acc-err-amt", text: fmt(short) }),
            h("span", { text: "." }),
          ),
          h("p", { class: "acc-modal-lede" },
            h("span", { text: "Budget an additional " }),
            h("strong", { text: fmt(short) }),
            h("span", { text: ` to the ${a.name} payment category, then pay off the card balance before attempting to ${actionLabel.toLowerCase()} it.` }),
          ),
          btn("OK", { block: true, onClick: () => sheet.close() }),
        );
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
  const accounts = [...(budget.accounts || []), ...(budget.creditCards || [])];
  const fromAcc = accounts.find((a) => a.id === fromId);
  const fromBal = Math.max(0, accountBalances(budget)[fromId] || 0);
  let to = opts.toId || (accounts.find((a) => !a.archived && a.id !== fromId)?.id || "");
  let amount = opts.amount != null ? round2(Math.abs(opts.amount)) : fromBal;
  let date = todayKey();
  let note = "";
  const sheet = openSheet({
    title: "💸 Transfer Money",
    closeLabel: "Discard",
    body: (host) => {
      const over = h("div", { class: "acc-form-err" });
      const saveBtn = btn("Transfer", { kind: "purple", onClick: () => submit() });
      const paintOver = () => {
        const overBalance = amount > fromBal + 0.005;
        over.textContent = overBalance ? `Amount exceeds the available balance of ${fmt(fromBal)}.` : "";
        saveBtn.disabled = !to || !amount || to === fromId || overBalance;
      };
      const submit = () => {
        const cap = Math.max(0, accountBalances(ctx.budget())[fromId] || 0);
        if (!to || to === fromId) { toast("Pick a different account"); return; }
        if (!(amount > 0)) { toast("Enter an amount"); return; }
        if (amount > cap + 0.005) { toast(`Amount exceeds the available balance of ${fmt(cap)}.`); return; }
        const res = addTransaction(ctx.budget(), { type: "transfer", accountId: fromId, transferAccountId: to, amount, date, payee: "Transfer", note: note.trim() });
        if (res.error) { toast(res.error); return; }
        ctx.updateBudget(() => res.budget);
        sheet.close();
        const watched = accountBalances(ctx.budget())[watchId] || 0;
        if (!onDone) toast("Transferred", { label: "Undo", action: () => ctx.undo() });
        onDone?.(watched);
      };
      const toSel = searchableSel({
        label: "To",
        value: to,
        placeholder: "Search accounts...",
        options: [{ value: "", label: "Select account..." }, ...accounts.filter((a) => !a.archived && a.id !== fromId).map((a) => ({ value: a.id, label: a.name }))],
        onChange: (v) => { to = v; paintOver(); },
      });
      const dateEl = h("input", { class: "input", type: "date", value: date });
      dateEl.addEventListener("change", () => { date = dateEl.value; });
      const noteEl = textInput({ placeholder: "e.g. Emergency fund deposit", value: note });
      noteEl.addEventListener("input", () => { note = noteEl.value; });
      paintOver();
      append(host,
        h("p", { class: "acc-transfer-lede", text: "Moves money between your checking, savings, or cash accounts. No effect on your budget." }),
        field("From", h("div", { class: "acc-from" },
          h("span", { class: "acc-from-name", text: fromAcc?.name || "—" }),
          h("span", { class: "acc-from-bal", text: `Balance: ${fmt(fromBal)}` }),
        )),
        toSel,
        amountInput({ label: "Amount", value: amount, placeholder: "0.00", onChange: (v) => { amount = Math.abs(v); paintOver(); }, onCommit: (v) => { amount = Math.abs(v); paintOver(); } }),
        over,
        field("Date", dateEl),
        field("Note (optional)", noteEl),
        btnRow({ label: "Cancel", kind: "ghost", onClick: () => sheet.close() }, saveBtn),
      );
    },
  });
}

function openReconcile(ctx, a, card, computed, after) {
  const budget = ctx.budget();
  const txs = (budget.transactions || []).filter((t) => t.accountId === a.id);
  const uncat = txs.filter((t) => t.type === "expense" && !t.splits && (!t.categoryId || t.categoryConfirmed === false));
  if (uncat.length) {
    const count = uncat.length;
    const sheet = openSheet({
      title: `Cannot Reconcile ${a.name}`,
      body: (host) => {
        const who = count !== 1 ? "are" : "is";
        const have = count !== 1 ? "have" : "has";
        host.append(
          h("p", { class: "acc-modal-lede" },
            h("strong", { text: `${count} transaction${count !== 1 ? "s" : ""}` }),
            h("span", { text: ` on this account ${who} missing a category or ${have} an unconfirmed category. All transactions must be categorized and confirmed before reconciling.` }),
          ),
          btn("OK — I'll Fix Them First", { block: true, onClick: () => { sheet.close(); ctx.go("transactions", { accountId: a.id, attention: true }); } }),
        );
      },
    });
    return;
  }
  const unlocked = txs.filter((t) => !isLocked(budget, t));
  const effect = (tx) => txBalanceEffect(tx, card);
  const checked = new Set(unlocked.map((t) => t.id));
  let date = todayKey();
  let real = Math.abs(computed);
  let userEdited = false;
  let suggestedIds = [];
  const sheet = openSheet({
    title: `Reconcile ${a.name}`,
    body: (host) => {
      const dateEl = h("input", { class: "input", type: "date", value: date, max: todayKey() });
      dateEl.addEventListener("change", () => { date = dateEl.value; });
      const diffRow = h("div", { class: "acc-rec-diff" });
      const suggest = h("div", { class: "acc-suggest" });
      const adjNote = h("div", { class: "acc-rec-adj" });
      const list = h("div", { class: "acc-rec-list" });
      const finish = btn("✅ Finish Reconciliation", { kind: "good", onClick: () => {
        const { matches } = figures();
        if (!matches) { toast("Uncheck transactions that haven’t cleared, or add an adjustment"); return; }
        ctx.updateBudget((b) => reconcileAccount(b, a.id, date, 0, [...checked]));
        sheet.close();
        toast("Reconciled");
        after?.();
      }});
      const adjust = btn("Add Adjustment & Reconcile", { kind: "purple", onClick: () => {
        const { diff, matches } = figures();
        if (matches) return;
        ctx.updateBudget((b) => reconcileAccount(b, a.id, date, diff, [...checked]));
        sheet.close();
        toast("Reconciled with adjustment", { label: "Undo", action: () => ctx.undo() });
        after?.();
      }});
      const figures = () => {
        const uncheckedSum = unlocked.filter((t) => !checked.has(t.id)).reduce((s, t) => s + effect(t), 0);
        const adjusted = computed - uncheckedSum;
        const diff = real - adjusted;
        return { uncheckedSum, adjusted, diff, matches: Math.abs(diff) < 0.005 };
      };
      const applySuggestion = () => {
        suggestedIds = [];
        checked.clear();
        unlocked.forEach((t) => checked.add(t.id));
        const gap = real - computed;
        if (Math.abs(gap) >= 0.005) {
          const suggestion = findUnclearedSuggestion(unlocked.map((t) => ({ ...t, amount: effect(t) })), gap);
          if (suggestion?.length) {
            suggestion.forEach((id) => checked.delete(id));
            suggestedIds = suggestion;
          }
        }
      };
      const paint = () => {
        const { adjusted, diff, matches, uncheckedSum } = figures();
        clear(diffRow);
        diffRow.append(h("span", { text: "Difference" }), h("span", { class: matches ? "ok" : "bad", text: matches ? "None — matches!" : fmt(diff) }));
        suggest.textContent = suggestedIds.length
          ? `💡 ${suggestedIds.length === 1 ? "1 transaction was" : `${suggestedIds.length} transactions were`} automatically unchecked to match your balance — re-check if incorrect.`
          : "";
        suggest.hidden = !suggestedIds.length;
        if (Math.abs(uncheckedSum) > 0.005) {
          clear(adjNote);
          adjNote.hidden = false;
          adjNote.append(
            h("span", { text: "Adjusted balance: " }),
            h("strong", { class: matches ? "ok" : "", text: fmt(adjusted) }),
            h("span", { text: " · Remaining gap: " }),
            h("strong", { class: "bad", text: fmt(diff) }),
          );
        } else {
          adjNote.hidden = true;
          adjNote.textContent = "";
        }
        finish.disabled = !matches;
        adjust.disabled = matches;
        adjust.textContent = matches ? "Add Adjustment & Reconcile" : `Add Adjustment (${fmt(diff)}) & Reconcile`;
        clear(list);
        for (const tx of [...unlocked].sort((x, y) => y.date.localeCompare(x.date))) {
          const on = checked.has(tx.id);
          const row = h("label", { class: `acc-rec-tx${on ? " on" : (suggestedIds.includes(tx.id) ? " suggested" : " off")}` });
          const box = h("input", { type: "checkbox", checked: on });
          box.addEventListener("change", () => {
            if (box.checked) checked.add(tx.id);
            else checked.delete(tx.id);
            suggestedIds = [];
            paint();
          });
          const amt = effect(tx);
          row.append(
            box,
            h("div", { class: "acc-rec-tx-main" },
              h("div", { class: "acc-rec-tx-payee", text: tx.payee || "—" }),
              h("div", { class: "acc-rec-tx-date", text: tx.date }),
            ),
            h("div", { class: amt < -0.005 ? "acc-rec-tx-amt in" : "acc-rec-tx-amt", text: fmt(amt) }),
          );
          list.append(row);
        }
      };
      const onReal = (n) => {
        real = Math.abs(n);
        userEdited = true;
        applySuggestion();
        paint();
      };
      append(host,
        field("Date", dateEl),
        h("p", { class: "acc-rec-shows", text: `ToozBudgeting shows: ${fmt(computed)}${card ? " owed" : ""}` }),
        amountInput({
          label: card ? "Actual balance owed, from your statement ($)" : "Actual balance, from your bank ($)",
          value: real, placeholder: "0.00", allowNegative: !card,
          onChange: onReal, onCommit: onReal,
        }),
        diffRow,
        h("div", { class: "acc-rec-btns" },
          btn("Cancel", { kind: "ghost", onClick: () => sheet.close() }),
          adjust,
        ),
        finish,
      );
      if (unlocked.length) {
        host.append(
          h("div", { class: "acc-rec-block" },
            h("div", { class: "acc-rec-kicker", text: "Unreconciled Transactions — uncheck any that haven't cleared yet" }),
            suggest,
            adjNote,
            list,
          ),
        );
      }
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
  let balance = null;
  let error = "";
  const sheet = openSheet({
    title: card ? "Add Credit Card" : "Add Account",
    closeLabel: "Discard",
    body: (host) => {
      const err = h("div", { class: "acc-form-err" });
      const save = btn(card ? "Add Card" : "Add Account", { kind: "good", onClick: () => submit() });
      const paintSave = () => { save.disabled = !name.trim() || balance === null; err.textContent = error; };
      const submit = () => {
        error = "";
        if (!name.trim()) { error = "Name is required."; paintSave(); return; }
        if (balance === null) { error = "Enter a balance."; paintSave(); return; }
        const list = card ? ctx.budget().creditCards : ctx.budget().accounts;
        if (list.some((x) => x.name.toLowerCase() === name.trim().toLowerCase())) {
          error = `"${name.trim()}" already exists.`;
          paintSave();
          return;
        }
        ctx.updateBudget((b) => card ? addCreditCard(b, { name, balance }) : addAccount(b, { name, type, balance }));
        sheet.close();
        toast("Added. Starting balance is locked.");
      };
      const nm = textInput({ placeholder: card ? "Chase Visa, Amex Blue..." : "Chase Checking" });
      nm.setAttribute("autofocus", "");
      nm.addEventListener("input", () => { name = nm.value; error = ""; paintSave(); });
      const kids = [
        h("div", { class: "acc-add-hint", text: card ? "💡 Existing balance reserved in your budget." : "💡 Opening balance added to Ready to Assign." }),
        field(card ? "Card Name" : "Account Name", nm),
      ];
      if (!card) {
        const typeSel = h("select", { class: "input" },
          h("option", { value: "checking", text: "Checking" }),
          h("option", { value: "savings", text: "Savings" }),
          h("option", { value: "cash", text: "Cash" }),
        );
        typeSel.addEventListener("change", () => { type = typeSel.value; });
        kids.push(h("div", { class: "acc-add-grid" },
          field("Type", typeSel),
          amountInput({ label: "Balance ($)", placeholder: "e.g. 1000", onChange: (v) => { balance = v; error = ""; paintSave(); }, onCommit: (v) => { balance = v; error = ""; paintSave(); } }),
        ));
      } else {
        kids.push(amountInput({ label: "Balance Owed ($)", placeholder: "e.g. 450.00", onChange: (v) => { balance = Math.abs(v); error = ""; paintSave(); }, onCommit: (v) => { balance = Math.abs(v); error = ""; paintSave(); } }));
      }
      paintSave();
      append(host, ...kids, err, btnRow({ label: "Cancel", kind: "ghost", onClick: () => sheet.close() }, save));
      nm.focus();
    },
  });
}

