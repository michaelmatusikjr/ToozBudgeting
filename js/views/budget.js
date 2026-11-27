import { h, btn, openSheet, field, textInput, toast, moneyButton, confirmDialog, openAmountPad } from "../ui.js?v=140";
import { fmt, monthLabel, monthKey, prevMonth, nextMonth, todayKey, toTitleCase, uid, round2 } from "../util.js?v=140";
import {
  budgetSnapshot, getGoalMetrics, trailingAvg, monthAccessible, historySeries,
  overspentMonths, available, globalFree, ccMismatches,
} from "../calc.js?v=140";
import {
  setAssigned, moveMoney, coverOverspending, planClawback, applyClawback,
  computeMonthAssignments, applyAssignments, setCategory, addCategory, archiveCategory,
  deleteCategory, setMonthNote, addGroup, renameGroup, deleteGroup, moveGroup, moveCategory,
} from "../mutate.js?v=140";
import { collectReminders } from "../notify.js?v=140";
import { openMissingSide } from "./transactions.js?v=140";

function noteOf(budget, month, cat) {
  return budget.categoryNotes?.[month]?.[cat.id] || "";
}

const GOAL_HEADING = "--- Goal Changes ---";

function describeGoal(g) {
  if (!g?.type) return "No goal";
  if (g.type === "monthly") return `Monthly: ${fmt(g.target || 0)}`;
  if (g.type === "savings") return `Savings target: ${fmt(g.target || 0)}`;
  if (g.type === "date") return `By ${g.targetDate || "?"}: ${fmt(g.target || 0)}`;
  return "No goal";
}

function splitGoalNote(full) {
  const text = full || "";
  const i = text.indexOf(GOAL_HEADING);
  if (i < 0) return { editable: text, changes: "" };
  return { editable: text.slice(0, i).trimEnd(), changes: text.slice(i + GOAL_HEADING.length).trim() };
}

function joinGoalNote(editable, changes) {
  if (!changes) return editable || "";
  const head = (editable || "").trimEnd();
  return (head ? `${head}\n\n` : "") + `${GOAL_HEADING}\n${changes}`;
}

export function withGoalChange(note, oldGoal, newGoal) {
  const oldDesc = describeGoal(oldGoal);
  const newDesc = describeGoal(newGoal);
  if (oldDesc === newDesc) return note || "";
  const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const parts = splitGoalNote(note);
  const changes = parts.changes ? `${parts.changes}\n${oldDesc} → ${newDesc} on ${today}` : `${oldDesc} → ${newDesc} on ${today}`;
  return joinGoalNote(parts.editable, changes);
}

export function renderBudget(root, ctx) {
  const budget = ctx.budget();
  if (!budget) { root.append(h("p", { text: "No budget selected." })); return; }
  const month = ctx.month;
  const today = monthKey();
  const snap = budgetSnapshot(budget, month, today);
  const collapsed = ctx.ui.collapsed;

  const prevMk = prevMonth(month);
  const nextMk = nextMonth(month);
  const prevOk = monthAccessible(budget, prevMk, today);
  const nextOk = monthAccessible(budget, nextMk, today);
  const head = h("div", { class: "month-nav" },
    h("button", { class: "icon-btn", type: "button", "aria-label": "Previous month", text: "‹", disabled: !prevOk, onclick: () => { if (prevOk) ctx.setMonth(prevMk); } }),
    h("button", { class: "month-label", type: "button", text: monthLabel(month), onclick: () => ctx.setMonth(today) }),
    h("button", { class: "icon-btn", type: "button", "aria-label": "Next month", text: "›", disabled: !nextOk, onclick: () => {
      if (!nextOk) { toast("Assign money in the previous month first"); return; }
      ctx.setMonth(nextMk);
    } }),
  );
  const planLinks = h("nav", { class: "link-row plan-actions", "aria-label": "Plan" },
    h("button", { class: "text-link", type: "button", text: "Auto-assign", onclick: () => openAuto(ctx) }),
    h("button", { class: "text-link", type: "button", text: "Move", onclick: () => openMove(ctx, null, null) }),
    h("button", { class: "text-link", type: "button", text: "Add", onclick: () => openAddCategory(ctx) }),
    h("button", { class: "text-link", type: "button", text: "Goals", onclick: () => openAllGoals(ctx) }),
    h("button", { class: "text-link", type: "button", text: "History", onclick: () => openHistory(ctx) }),
    h("button", { class: "text-link", type: "button", text: "Log", onclick: () => openLog(ctx) }),
    h("button", { class: "text-link", type: "button", text: ctx.ui.showArchived ? "Hide archived" : "Archived", onclick: () => { ctx.ui.showArchived = !ctx.ui.showArchived; ctx.render(); } }),
  );

  const rtaClass = snap.free < -0.005 ? "rta bad" : snap.free < 0.005 ? "rta zero" : "rta";
  const returned = snap.returned > 0.005 ? ` · ${fmt(snap.returned)} returned` : "";
  const rta = h("section", { class: rtaClass },
    h("p", { class: "kicker", text: "Ready to Assign" }),
    h("p", { class: "rta-num", text: fmt(snap.free) }),
    h("p", { class: "muted", text: month === today ? `This month ${fmt(snap.rta)} · ${fmt(snap.ahead)} assigned ahead${returned}` : `Showing ${monthLabel(month)}${returned}` }),
  );

  const overs = overspentMonths(budget, today).filter((o) => o.month <= today);
  const notices = h("div", { class: "notices" });
  if (overs.length) {
    const oldest = overs[0];
    const extra = overs.length > 1 ? ` (+${overs.length - 1} more)` : "";
    notices.append(h("button", { class: "notice", type: "button", onclick: () => { ctx.setMonth(oldest.month); openCover(ctx, oldest.month); } },
      h("strong", { text: `Overspending in ${monthLabel(oldest.month)}${extra}` }),
      h("span", { text: "Covering moves money from other categories so those balances come back to zero. Start with the oldest month." }),
      h("span", { class: "notice-go", text: "Cover" }),
    ));
  }
  for (const cat of expiredDateGoals(budget)) {
    notices.append(h("button", { class: "notice warn", type: "button", onclick: () => openCategory(ctx, cat) },
      h("strong", { text: `${cat.name} goal date has passed` }),
      h("span", { class: "notice-go", text: "Edit" }),
    ));
  }

  for (const miss of ccMismatches(budget, today)) {
    notices.append(h("button", { class: "notice warn", type: "button", onclick: () => {
      const openPad = () => {
        const live = ctx.budget();
        const cat = (live.categories || []).find((c) => c.id === miss.pay.id);
        if (!cat) return;
        const cur = Number((live.monthlyBudgets?.[today] || {})[cat.id] || 0);
        openAmountPad({
          title: cat.name,
          value: round2(cur + miss.short),
          allowNegative: true,
          onCommit: (val) => commitAssigned(ctx, cat, today, val),
        });
      };
      if (ctx.month !== today) ctx.setMonth(today);
      openPad();
    } },
      h("strong", { text: `${miss.card.name} payment is short ${fmt(miss.short)}` }),
      h("span", { text: `Balance ${fmt(miss.owed)}. Set aside ${fmt(Math.max(0, miss.setAside))}.` }),
      h("span", { class: "notice-go", text: "Assign" }),
    ));
  }

  const groups = h("div", { class: "groups" });
  for (const g of budget.categoryGroups || []) {
    const cats = (budget.categories || []).filter((c) => c.groupId === g.id && (ctx.ui.showArchived || !c.archived));
    if (!cats.length && g.name === "Uncategorized") continue;
    const open = !collapsed[g.id];
    const gAvail = cats.reduce((s, c) => s + Number(snap.available[c.id] || 0), 0);
    const sec = h("section", { class: "group" });
    const gCls = gAvail < -0.005 ? "neg" : gAvail > 0.005 ? "pos" : "zero";
    sec.append(h("button", { class: "group-h", type: "button", onclick: () => { collapsed[g.id] = !collapsed[g.id]; ctx.render(); } },
      h("span", { class: "chev", text: open ? "▾" : "▸" }),
      h("span", { class: "grow", text: g.name }),
      h("span", { class: `num ${gCls}`, text: fmt(gAvail) }),
    ));
    if (open) {
      for (const cat of cats) sec.append(categoryRow(ctx, cat, snap, month, today));
      sec.append(h("div", { class: "group-foot" },
        h("button", { class: "quiet-link", type: "button", text: "Activity", onclick: (e) => { e.stopPropagation(); ctx.go("transactions", { groupId: g.id, month }); } }),
        g.name === "Credit Card Payments" ? null : h("button", { class: "quiet-link", type: "button", text: "Edit", onclick: (e) => { e.stopPropagation(); openGroup(ctx, g); } }),
      ));
    }
    groups.append(sec);
  }

  root.append(head, h("div", { class: "plan-stick" }, rta, planLinks), notices, groups);
  if (ctx.ui.focusCat) {
    const id = ctx.ui.focusCat;
    ctx.ui.focusCat = null;
    const cat = (budget.categories || []).find((c) => c.id === id);
    if (cat) openCategory(ctx, cat);
  }
}

function commitAssigned(ctx, cat, month, val) {
  if (!Number.isFinite(val)) return;
  const plan = planClawback(ctx.budget(), month, cat.id, val);
  if (plan.direct) {
    ctx.updateBudget((b) => setAssigned(b, month, cat.id, val));
    return;
  }
  if (plan.insufficient) {
    const sheet = openSheet({
      title: "Not enough money",
      body: (host) => {
        host.append(h("p", { class: "lede", text: `That needs ${fmt(plan.shortfall)} more than is Ready to Assign, and only ${fmt(plan.available)} can be pulled back from future months.` }));
        host.append(h("p", { class: "hint", text: "This change can’t be made. You’d be assigning money you don’t have." }));
        host.append(btn("OK", { block: true, onClick: () => sheet.close() }));
      },
    });
    return;
  }
  if (plan.ok && plan.plan) {
    const sheet = openSheet({
      title: "Free up money from future months?",
      body: (host) => {
        host.append(h("p", { class: "lede", text: `${cat.name} needs ${fmt(plan.shortfall)} more than is Ready to Assign. That money is already assigned in later months.` }));
        host.append(h("p", { class: "kicker", text: "Unassign to cover it" }));
        for (const step of plan.plan) {
          host.append(h("div", { class: "line" },
            h("span", { text: `${step.categoryName} · ${monthLabel(step.month)}` }),
            h("span", { class: "money neg", text: `−${fmt(step.amount)}` }),
          ));
        }
        host.append(h("div", { class: "line" }, h("strong", { text: "Total unassigned" }), h("strong", { text: fmt(plan.shortfall) })));
        host.append(h("div", { class: "row gap" },
          btn("Cancel", { kind: "ghost", onClick: () => sheet.close() }),
          btn("Free it up", { onClick: () => {
            ctx.updateBudget((b) => applyClawback(b, month, plan.plan, cat.id, val, plan.shortfall));
            sheet.close();
            toast("Moved from later months", { label: "Undo", action: () => ctx.undo() });
          }}),
        ));
      },
    });
    return;
  }
  ctx.updateBudget((b) => setAssigned(b, month, cat.id, val));
}

function categoryRow(ctx, cat, snap, month, today) {
  const budgeted = Number(snap.budgeted[cat.id] || 0);
  const activity = Number(snap.activity[cat.id] || 0);
  const avail = Number(snap.available[cat.id] || 0);
  const metrics = getGoalMetrics(cat, avail, budgeted, month);
  const underfunded = !!(metrics && !metrics.complete && ((metrics.type === "monthly" && metrics.underfunded) || (metrics.type === "date" && !metrics.onTrack) || (metrics.type === "savings" && avail < (metrics.target || 0) - 0.005)));
  const avg = trailingAvg(ctx.budget(), cat.id, month);
  const note = noteOf(ctx.budget(), month, cat);
  const row = h("article", { class: `cat ${avail < -0.005 ? "over" : ""} ${underfunded ? "under" : ""} ${cat.archived ? "archived" : ""}` });
  const title = h("button", { class: "cat-name", type: "button", text: cat.name, onclick: () => openCategory(ctx, cat) });
  const flag = underfunded ? h("span", { class: "goal-flag", text: "Under" }) : null;
  const subBits = [];
  if (metrics) {
    subBits.push(metrics.type === "monthly"
      ? (metrics.underfunded ? `Needs ${fmt(metrics.needed)}` : "Funded")
      : metrics.type === "date"
        ? (metrics.complete ? "Goal reached" : metrics.expired ? "Date passed" : `${fmt(metrics.monthlyNeeded)} a month`)
        : `${Math.round(metrics.progress || 0)}% saved`);
  }
  if (avg) subBits.push(`avg ${fmt(avg.avg)}`);
  const sub = (subBits.length || note || cat.note)
    ? h("div", { class: "cat-sub" },
      subBits.length ? h("span", { text: subBits.join(" · ") }) : null,
      (note || cat.note) ? h("button", { class: "text-link note-link", type: "button", text: "Note", onclick: () => openNote(ctx, cat) }) : null,
    )
    : null;

  const bBtn = h("button", { class: `num-btn fig ${budgeted ? "" : "zero"}`, type: "button", onclick: () => {
    openAmountPad({
      title: cat.name,
      value: budgeted,
      allowNegative: true,
      onCommit: (val) => commitAssigned(ctx, cat, month, val),
    });
  }});
  bBtn.append(h("span", { class: "fig-k", text: "Assigned" }), h("span", { class: "fig-n", text: fmt(budgeted) }));

  const actCls = activity > 0.005 ? "num-btn fig neg" : activity < -0.005 ? "num-btn fig pos" : "num-btn fig zero";
  const actText = activity > 0.005 || activity < -0.005 ? fmt(-activity) : fmt(0);
  const avCls = avail < -0.005 ? "num-btn avail neg" : avail > 0.005 ? "num-btn avail pos" : "num-btn avail zero";
  const bar = metrics && (metrics.type === "savings" || metrics.type === "date")
    ? h("div", { class: "goal-bar" }, h("span", { style: `width:${Math.max(0, Math.min(100, metrics.complete ? 100 : (metrics.progress != null ? metrics.progress : (metrics.target ? (avail / metrics.target) * 100 : 0))))}%` }))
    : null;

  const availControl = Math.abs(avail) < 0.005
    ? h("div", { class: avCls }, h("span", { class: "fig-n", text: fmt(avail) }))
    : h("button", { class: avCls, type: "button", onclick: () => {
      if (avail < -0.005) openMove(ctx, null, cat.id);
      else openMove(ctx, cat.id, null);
    } }, h("span", { class: "fig-n", text: fmt(avail) }));

  row.append(
    h("div", { class: "cat-id" }, h("div", { class: "cat-title" }, title, flag), sub),
    availControl,
    h("div", { class: "cat-figs" },
      bBtn,
      h("button", { class: actCls, type: "button", onclick: () => ctx.go("transactions", { categoryId: cat.id, month }) },
        h("span", { class: "fig-k", text: "Activity" }),
        h("span", { class: "fig-n", text: actText }),
      ),
    ),
  );
  if (bar) row.append(bar);
  return row;
}

function openMove(ctx, fromId, toId) {
  const budget = ctx.budget();
  const month = ctx.month;
  const snap = budgetSnapshot(budget, month);
  let from = fromId || "rta";
  let to = toId || "";
  let amount = 0;
  if (toId && fromId == null) {
    const av = snap.available[toId] || 0;
    if (av < -0.005) amount = round2(Math.abs(av));
  }
  const sheet = openSheet({
    title: "Move money",
    body: (host) => {
      const paint = () => {
        const fromAvail = from === "rta" ? Math.max(0, snap.free) : Math.max(0, snap.available[from] || 0);
        const fromSel = h("select", { class: "input" });
        const toSel = h("select", { class: "input" });
        fromSel.append(h("option", { value: "rta", text: `Ready to Assign (${fmt(Math.max(0, snap.free))})` }));
        toSel.append(h("option", { value: "", text: "Select destination" }), h("option", { value: "rta", text: "Ready to Assign" }));
        for (const g of budget.categoryGroups || []) {
          const og1 = h("optgroup", { label: g.name });
          const og2 = h("optgroup", { label: g.name });
          let n1 = 0;
          let n2 = 0;
          for (const c of budget.categories.filter((c) => c.groupId === g.id && !c.archived)) {
            const av = snap.available[c.id] || 0;
            og1.append(h("option", { value: c.id, text: `${c.name} (${fmt(av)})`, disabled: av <= 0 }));
            n1++;
            if (c.id !== from) { og2.append(h("option", { value: c.id, text: c.name })); n2++; }
          }
          if (n1) fromSel.append(og1);
          if (n2) toSel.append(og2);
        }
        fromSel.value = from;
        toSel.value = to;
        fromSel.addEventListener("change", () => { from = fromSel.value; if (to === from) to = ""; paint(); });
        toSel.addEventListener("change", () => { to = toSel.value; paint(); });
        const err = h("p", { class: "error", text: "" });
        const can = to && from !== to && amount > 0.005;
        host.replaceChildren(
          field("From", fromSel),
          field("To", toSel),
          field(`Amount (max ${fmt(fromAvail)})`, moneyButton(amount, (n) => { amount = round2(n); paint(); })),
          err,
          btn("Move money", { block: true, disabled: !can, onClick: () => {
            const avail = from === "rta" ? Math.max(0, snap.free) : Math.max(0, snap.available[from] || 0);
            if (!to || from === to || !(amount > 0.005)) return;
            if (amount > avail + 0.001) { err.textContent = `Only ${fmt(avail)} available.`; return; }
            ctx.updateBudget((b) => moveMoney(b, month, from === "rta" ? null : from, to === "rta" ? null : to, amount));
            sheet.close();
            toast("Money moved", { label: "Undo", action: () => ctx.undo() });
          }}),
        );
      };
      paint();
    },
  });
}

function catName(budget, id) {
  if (!id || id === "rta") return "Ready to Assign";
  return budget.categories?.find((c) => c.id === id)?.name || "Unknown";
}

function openCover(ctx, month, note) {
  const budget = ctx.budget();
  const snap = budgetSnapshot(budget, month);
  const overs = (budget.categories || []).filter((c) => !c.archived && !c.creditCardId && (snap.available[c.id] || 0) < -0.005);
  if (!overs.length) { toast("Nothing overspent this month"); return; }
  const total = overs.reduce((s, c) => s + Math.abs(snap.available[c.id] || 0), 0);
  const rta = Math.max(0, snap.free);
  const availOf = (id) => (id === "rta" ? rta : (snap.available[id] || 0));
  const sources = [];
  const before = new Set(overspentMonths(budget, monthKey()).map((o) => o.month));
  const sheet = openSheet({
    title: `Cover overspending — ${monthLabel(month)}`,
    body: (host) => {
      const paint = () => {
        const covered = sources.reduce((s, src) => s + src.amount, 0);
        const gap = Math.max(0, round2(total - covered));
        const used = new Set(sources.map((s) => s.id));
        const options = [];
        if (rta > 0.005 && !used.has("rta")) options.push({ id: "rta", name: "Ready to Assign", available: rta, group: "" });
        for (const g of budget.categoryGroups || []) {
          for (const c of budget.categories || []) {
            if (c.groupId !== g.id || c.archived || c.creditCardId || used.has(c.id)) continue;
            const av = snap.available[c.id] || 0;
            if (av > 0.005) options.push({ id: c.id, name: c.name, available: av, group: g.name });
          }
        }
        const pool = options.reduce((s, o) => s + o.available, 0) + sources.reduce((s, src) => s + availOf(src.id), 0);
        const noMoney = pool < 0.005 && sources.length === 0;
        const kids = [];
        if (note) kids.push(h("p", { class: "lede", text: note }));
        kids.push(h("p", { class: "kicker", text: "Overspent categories" }));
        for (const c of overs) {
          kids.push(h("div", { class: "line" }, h("span", { text: c.name }), h("span", { class: "money neg", text: fmt(snap.available[c.id]) })));
        }
        kids.push(h("div", { class: "line" }, h("strong", { text: "Total to cover" }), h("span", { class: "money neg", text: fmt(-total) })));
        if (noMoney) {
          kids.push(h("p", { class: "hint", text: "There are no available funds in any category or Ready to Assign to cover this overspending. Add income or reduce spending in another category first." }));
        } else {
          if (sources.length) {
            kids.push(h("p", { class: "kicker", text: "Pulling from" }));
            for (const src of sources) {
              kids.push(h("div", { class: "line" },
                h("span", { text: catName(budget, src.id) }),
                h("span", { class: "muted", text: `Available ${fmt(availOf(src.id))}` }),
                h("button", { class: "text-link", type: "button", text: "Remove", onclick: () => {
                  const i = sources.findIndex((s) => s.id === src.id);
                  if (i >= 0) sources.splice(i, 1);
                  paint();
                } }),
              ));
              kids.push(moneyButton(src.amount, (n) => {
                const avail = availOf(src.id);
                const coveredNow = sources.reduce((s, x) => s + x.amount, 0);
                const room = Math.max(0, total - coveredNow) + src.amount;
                src.amount = round2(Math.min(Math.max(0, n), Math.min(avail, room)));
                paint();
              }, { label: catName(budget, src.id) }));
            }
            kids.push(h("div", { class: "line" },
              h("strong", { text: "Remaining gap" }),
              h("span", { class: gap < 0.005 ? "money pos" : "money neg", text: gap < 0.005 ? "Covered" : fmt(-gap) }),
            ));
          }
          if (options.length && gap > 0.005) {
            const sel = h("select", { class: "input" });
            sel.append(h("option", { value: "", text: "Select a category to add…" }));
            let last = null;
            let group = null;
            for (const o of options) {
              if (o.group !== last) {
                if (group) sel.append(group);
                last = o.group;
                group = o.group ? h("optgroup", { label: o.group }) : null;
              }
              const opt = h("option", { value: o.id, text: `${o.name} (${fmt(o.available)} available)` });
              if (group) group.append(opt);
              else sel.append(opt);
            }
            if (group) sel.append(group);
            sel.addEventListener("change", () => {
              const id = sel.value;
              if (!id || sources.some((s) => s.id === id)) return;
              const avail = availOf(id);
              if (avail <= 0.005) return;
              const coveredNow = sources.reduce((s, x) => s + x.amount, 0);
              const rem = Math.max(0, total - coveredNow);
              sources.push({ id, amount: round2(Math.min(avail, rem)) });
              paint();
            });
            kids.push(field("Pull from", sel));
          }
          if (!options.length && gap > 0.005) {
            kids.push(h("p", { class: "hint", text: "No more sources available. You can partially cover and return later." }));
          }
        }
        const canApply = !noMoney && sources.some((s) => s.amount > 0.005);
        kids.push(btn("Apply", { block: true, disabled: !canApply, onClick: () => {
          if (!canApply) return;
          const use = sources.filter((s) => s.amount > 0.005).map((s) => ({ id: s.id, amount: s.amount }));
          ctx.updateBudget((b) => coverOverspending(b, month, use));
          sheet.close();
          const b = ctx.budget();
          const today = monthKey();
          const next = overspentMonths(b, today).find((o) => o.month > month);
          if (next) {
            const created = !before.has(next.month);
            ctx.setMonth(next.month);
            openCover(ctx, next.month, created ? `Covering overspending in ${monthLabel(month)} created overspending in ${monthLabel(next.month)}. Please cover it below.` : null);
            return;
          }
          const stillHere = (b.categories || []).some((c) => !c.archived && !c.creditCardId && available(b, c.id, month) < -0.005);
          toast(stillHere ? "Partly covered. This month is still overspent." : "Overspending covered", { label: "Undo", action: () => ctx.undo() });
        }}));
        host.replaceChildren(...kids);
      };
      paint();
    },
  });
}

function expiredDateGoals(budget) {
  const today = monthKey();
  return (budget.categories || []).filter((c) => c.goal?.type === "date" && c.goal.targetDate && c.goal.targetDate < today && !c.archived);
}

function openExpired(ctx, cats, then) {
  const choices = {};
  const sheet = openSheet({
    title: "Goals past their date",
    body: (host) => {
      host.append(h("p", { class: "lede", text: "These target-by-date goals have passed. Set a new goal or remove each one before auto-assign continues." }));
      for (const cat of cats) {
        const box = h("div", { class: "pair" });
        const date = h("input", { class: "input", type: "month", min: nextMonth(monthKey()) });
        let target = cat.goal?.target || 0;
        box.append(h("strong", { text: cat.name }), h("p", { class: "hint", text: `${fmt(cat.goal.target)} by ${cat.goal.targetDate}` }),
          field("New month", date), field("New target", moneyButton(target, (n) => { target = n; })),
          h("div", { class: "row gap wrap" },
            btn("Use new goal", { kind: "ghost", onClick: () => {
              if (!date.value || date.value <= monthKey()) { toast("Pick a future month"); return; }
              if (!(target > 0)) { toast("Enter a target amount"); return; }
              choices[cat.id] = { date: date.value, amount: target };
              toast("Noted");
            } }),
            btn("Remove goal", { kind: "quiet", onClick: () => { choices[cat.id] = "remove"; toast("Will remove"); } }),
          ));
        host.append(box);
      }
      host.append(btn("Continue", { block: true, onClick: () => {
        if (cats.some((c) => !choices[c.id])) { toast("Resolve each goal first"); return; }
        ctx.updateBudget((b) => ({
          ...b,
          categories: b.categories.map((c) => {
            const res = choices[c.id];
            if (!res) return c;
            if (res === "remove") return { ...c, goal: null, rollover: "rollover" };
            return { ...c, goal: { type: "date", target: res.amount, targetDate: res.date } };
          }),
        }));
        sheet.close();
        then?.();
      }}));
    },
  });
}

function openAuto(ctx) {
  const budget = ctx.budget();
  const month = ctx.month;
  const expired = expiredDateGoals(budget);
  if (expired.length) { openExpired(ctx, expired, () => openAuto(ctx)); return; }
  runAuto(ctx, month, null);
}

function stillUnderfunded(budget, mk) {
  return (budget.categories || []).some((cat) => {
    if (!cat.goal?.type || cat.archived) return false;
    const avail = available(budget, cat.id, mk);
    const budgeted = (budget.monthlyBudgets?.[mk] || {})[cat.id] || 0;
    const m = getGoalMetrics(cat, avail, budgeted, mk);
    if (!m || m.complete) return false;
    return (m.type === "monthly" && m.underfunded) || (m.type === "date" && !m.onTrack);
  });
}

function runAuto(ctx, month, carried) {
  const budget = ctx.budget();
  const result = computeMonthAssignments(budget, month, budget.monthlyBudgets || {}, budget.inflows || {});
  const all = carried ? carried.map((b) => ({ ...b, assignments: [...(b.assignments || [])] })) : [];
  if (!result.assignments.length) {
    if (!all.length) { toast("Nothing to assign. Goals are funded, or Ready to Assign is empty."); return; }
    proceedAfter(ctx, month, all);
    return;
  }
  openAssignPreview(ctx, month, result, all);
}

function openAssignPreview(ctx, month, result, all) {
  const budget = ctx.budget();
  const amounts = {};
  result.assignments.forEach((a) => { amounts[a.categoryId] = a.amount; });
  const sheet = openSheet({
    title: `Auto-assign — ${monthLabel(month)}`,
    body: (host) => {
      const paint = () => {
        const total = Object.values(amounts).reduce((s, v) => s + (Number(v) || 0), 0);
        const remaining = globalFree(ctx.budget(), month) - total;
        const kids = [h("p", { class: "lede", text: "Review the suggested amounts. Tap any amount to change it before it lands." })];
        for (const a of result.assignments) {
          const cat = budget.categories.find((c) => c.id === a.categoryId);
          kids.push(h("div", { class: "line" }, h("span", { text: cat?.name || "Category" }), moneyButton(amounts[a.categoryId] || 0, (n) => {
            amounts[a.categoryId] = round2(Math.max(0, n));
            paint();
          })));
        }
        kids.push(h("div", { class: "line" },
          h("span", { text: "Ready to Assign after this" }),
          h("span", { class: remaining < -0.001 ? "money neg" : "money pos", text: fmt(remaining) }),
        ));
        if (remaining < -0.001) kids.push(h("p", { class: "error", text: "That total is more than Ready to Assign. Reduce one or more amounts." }));
        const ok = remaining >= -0.001 && total > 0.005;
        kids.push(h("div", { class: "row gap" },
          btn("Cancel", { kind: "ghost", onClick: () => sheet.close() }),
          btn("Assign", { block: true, disabled: !ok, onClick: () => {
            if (!ok) return;
            ctx.updateBudget((b) => applyAssignments(b, month, amounts));
            sheet.close();
            const applied = result.assignments.map((a) => ({ categoryId: a.categoryId, amount: amounts[a.categoryId] || 0 })).filter((a) => a.amount > 0.005);
            const next = [...all];
            if (applied.length) next.push({ month, assignments: applied });
            proceedAfter(ctx, month, next);
          }}),
        ));
        host.replaceChildren(...kids);
      };
      paint();
    },
  });
}

function proceedAfter(ctx, month, all) {
  const budget = ctx.budget();
  const left = globalFree(budget, month);
  if (stillUnderfunded(budget, month) || !(left > 0.005)) { openRecap(ctx, all); return; }
  const goals = (budget.categories || []).filter((c) => {
    if (c.goal?.type !== "savings" || c.archived) return false;
    const cur = available(budget, c.id, month);
    return (c.goal.target || 0) - cur > 0.001;
  }).map((c) => {
    const current = available(budget, c.id, month);
    const target = c.goal.target || 0;
    return { id: c.id, name: c.name, current, target, need: Math.max(0, target - current) };
  });
  if (goals.length) openSavings(ctx, month, all, goals, left);
  else if ((budget.categories || []).some((c) => c.goal?.type && !c.archived)) openCascade(ctx, month, all, left);
  else openRecap(ctx, all);
}

function openSavings(ctx, month, all, goals, left) {
  const amounts = {};
  const sheet = openSheet({
    title: "Fund savings goals?",
    body: (host) => {
      const paint = () => {
        const allocated = Object.values(amounts).reduce((s, v) => s + (Number(v) || 0), 0);
        const after = left - allocated;
        const kids = [h("p", { class: "lede", text: `${fmt(left)} is left after this month’s other goals. Savings targets aren’t filled automatically.` })];
        for (const g of goals) {
          kids.push(h("div", { class: "pair" },
            h("div", { class: "line" },
              h("strong", { text: g.name }),
              h("span", { class: "muted", text: `${fmt(g.current)} of ${fmt(g.target)} · needs ${fmt(g.need)}` }),
            ),
            moneyButton(amounts[g.id] || 0, (n) => {
              amounts[g.id] = round2(Math.max(0, Math.min(n, g.need)));
              paint();
            }),
          ));
        }
        kids.push(h("div", { class: "line" },
          h("span", { text: "Remaining after this" }),
          h("span", { class: after < -0.001 ? "money neg" : "money pos", text: fmt(after) }),
        ));
        if (after < -0.001) kids.push(h("p", { class: "error", text: "That’s more than what’s available. Reduce one or more amounts." }));
        const ok = after >= -0.001 && allocated > 0.005;
        kids.push(h("div", { class: "row gap" },
          btn("Skip", { kind: "ghost", onClick: () => { sheet.close(); afterSavings(ctx, month, all, left); } }),
          btn("Assign", { block: true, disabled: !ok, onClick: () => {
            if (!ok) return;
            ctx.updateBudget((b) => applyAssignments(b, month, amounts));
            sheet.close();
            const applied = Object.entries(amounts).filter(([, n]) => n > 0.005).map(([categoryId, amount]) => ({ categoryId, amount }));
            const next = all.map((b) => ({ ...b, assignments: [...(b.assignments || [])] }));
            const bucket = next.find((a) => a.month === month);
            if (applied.length && bucket) bucket.assignments.push(...applied);
            else if (applied.length) next.push({ month, assignments: applied });
            afterSavings(ctx, month, next, globalFree(ctx.budget(), month));
          }}),
        ));
        host.replaceChildren(...kids);
      };
      paint();
    },
  });
}

function afterSavings(ctx, month, all, left) {
  const budget = ctx.budget();
  if (left > 0.005 && (budget.categories || []).some((c) => c.goal?.type && !c.archived)) openCascade(ctx, month, all, left);
  else openRecap(ctx, all);
}

function openCascade(ctx, month, all, left) {
  const nxt = nextMonth(month);
  const sheet = openSheet({
    title: "This month’s goals are funded",
    body: (host) => {
      host.append(h("p", { class: "lede", text: `Goals for ${monthLabel(month)} are funded. ${fmt(left)} is still Ready to Assign.` }));
      host.append(btn("Fund every later month", { block: true, onClick: () => {
        ctx.updateBudget((b) => {
          let cur = b;
          let mk = nxt;
          const extra = [];
          for (let i = 0; i < 24; i++) {
            const res = computeMonthAssignments(cur, mk, cur.monthlyBudgets || {}, cur.inflows || {});
            if (!res.assignments.length) break;
            extra.push({ month: mk, assignments: res.assignments.map((a) => ({ categoryId: a.categoryId, amount: a.amount })) });
            const am = {};
            res.assignments.forEach((a) => { am[a.categoryId] = a.amount; });
            cur = applyAssignments(cur, mk, am);
            mk = nextMonth(mk);
          }
          sheet._extra = extra;
          return cur;
        });
        sheet.close();
        openRecap(ctx, [...all, ...(sheet._extra || [])]);
      }}));
      host.append(btn(`Continue with ${monthLabel(nxt)} only`, { kind: "ghost", block: true, onClick: () => {
        sheet.close();
        runAuto(ctx, nxt, all);
      }}));
      host.append(btn("Stop here", { kind: "quiet", block: true, onClick: () => { sheet.close(); openRecap(ctx, all); } }));
    },
  });
}

function openRecap(ctx, all) {
  const budget = ctx.budget();
  const blocks = (all || []).map((block) => ({
    month: block.month,
    items: (block.assignments || []).filter((a) => a.amount > 0.005).map((a) => ({
      name: budget.categories.find((c) => c.id === a.categoryId)?.name || "Category",
      amount: a.amount,
    })),
  })).filter((b) => b.items.length);
  if (!blocks.length) { toast("Assigned"); return; }
  const grand = blocks.reduce((s, b) => s + b.items.reduce((t, i) => t + i.amount, 0), 0);
  const sheet = openSheet({
    title: "Auto-assign recap",
    body: (host) => {
      host.append(h("p", { class: "lede", text: "Here’s everything that was assigned." }));
      for (const block of blocks) {
        host.append(h("p", { class: "kicker", text: monthLabel(block.month) }));
        for (const item of block.items) {
          host.append(h("div", { class: "line" }, h("span", { text: item.name }), h("span", { class: "money pos", text: `+${fmt(item.amount)}` })));
        }
        const sub = block.items.reduce((s, i) => s + i.amount, 0);
        host.append(h("div", { class: "line" }, h("span", { class: "muted", text: "Subtotal" }), h("span", { text: fmt(sub) })));
      }
      host.append(h("div", { class: "line" }, h("strong", { text: "Total assigned" }), h("strong", { text: fmt(grand) })));
      host.append(btn("Done", { block: true, onClick: () => sheet.close() }));
    },
  });
}

function openCategory(ctx, cat) {
  const budget = ctx.budget();
  const month = ctx.month;
  const today = monthKey();
  const past = month < today;
  let name = cat.name;
  let groupId = cat.groupId;
  let rollover = cat.rollover || "rollover";
  const changes = cat.rolloverChanges || [];
  const applicable = changes.filter((c) => c.month <= month).sort((a, b) => b.month.localeCompare(a.month));
  rollover = applicable[0]?.type || rollover;
  let rolloverMax = cat.rolloverMax || 0;
  let goalType = cat.goal?.type || "";
  let goalTarget = cat.goal?.target || 0;
  let goalDate = cat.goal?.targetDate || "";
  let note = cat.note || "";
  const goalNote = splitGoalNote(note);
  const sheet = openSheet({
    title: "Category",
    body: (host) => {
      const nm = textInput({ value: name });
      nm.addEventListener("input", () => { name = nm.value; });
      const group = h("select", { class: "input" });
      for (const g of budget.categoryGroups) {
        if (cat.creditCardId && g.name !== "Credit Card Payments" && g.id !== cat.groupId) continue;
        group.append(h("option", { value: g.id, text: g.name }));
      }
      group.value = groupId;
      group.disabled = !!cat.creditCardId;
      group.addEventListener("change", () => { groupId = group.value; });
      const goal = h("select", { class: "input" },
        h("option", { value: "", text: "No goal" }),
        h("option", { value: "monthly", text: "Monthly funding" }),
        h("option", { value: "date", text: "Target by date" }),
        h("option", { value: "savings", text: "Savings target" }),
      );
      goal.value = goalType;
      goal.disabled = !!cat.creditCardId;
      const goalBox = h("div");
      const rollBox = h("div");
      const paintExtra = () => {
        goalBox.replaceChildren();
        if (goalType === "monthly" || goalType === "savings" || goalType === "date") {
          goalBox.append(field("Target", moneyButton(goalTarget, (n) => { goalTarget = n; })));
        }
        if (goalType === "date") goalBox.append(field("Target month", h("input", { class: "input", type: "month", value: goalDate, min: today, onchange: (e) => { goalDate = e.target.value; } })));
        rollBox.replaceChildren();
        if (cat.creditCardId) { rollBox.append(h("p", { class: "hint", text: "Payment categories roll the full balance and don’t take goals." })); return; }
        if (goalType === "date") { rollBox.append(h("p", { class: "hint", text: "By-date goals carry up to the target and return the rest to Ready to Assign." })); return; }
        if (past) rollBox.append(h("p", { class: "hint", text: "Rollover changes apply from the current month forward. This past month is read-only." }));
        const opts = [
          ["rollover", "Roll over", "Leftover carries forward"],
          ["return", "Return to Ready to Assign", "Leftover goes back to Ready to Assign"],
          ["max", "Cap", "Carry up to a maximum"],
        ].filter((o) => !(goalType === "savings" && o[0] === "return"));
        for (const [val, title, desc] of opts) {
          const lab = h("label", { class: `choice ${rollover === val ? "on" : ""}` },
            h("input", { type: "radio", name: "roll", value: val, checked: rollover === val, disabled: past, onchange: () => { rollover = val; paintExtra(); } }),
            h("span", {}, h("strong", { text: title }), h("span", { class: "muted", text: desc })),
          );
          rollBox.append(lab);
        }
        if (!past && rollover === "max") {
          const min = goalType === "savings" ? goalTarget : 0;
          rollBox.append(field(min ? `Cap (minimum ${fmt(min)})` : "Cap", moneyButton(Math.max(rolloverMax, min), (n) => { rolloverMax = Math.max(n, min); })));
        }
      };
      goal.addEventListener("change", () => { goalType = goal.value; paintExtra(); });
      const nt = h("textarea", { class: "input", rows: "3" });
      nt.value = goalNote.editable;
      nt.addEventListener("input", () => { note = joinGoalNote(nt.value, goalNote.changes); });
      host.append(field("Name", nm), field("Group", group), field("Goal", goal), goalBox, h("p", { class: "kicker", text: "Rollover" }), rollBox, field("Category note", nt));
      if (goalNote.changes) host.append(h("p", { class: "kicker", text: "Goal changes" }), h("p", { class: "hint", text: goalNote.changes }));
      host.append(btn("Save", { block: true, onClick: () => {
        const titled = toTitleCase(name.trim());
        if (!titled) return;
        if (budget.categories.some((c) => c.id !== cat.id && c.name.toLowerCase() === titled.toLowerCase())) { toast("That category name already exists"); return; }
        const goalObj = cat.creditCardId ? (cat.goal || null) : (goalType ? { type: goalType, target: goalTarget, ...(goalType === "date" ? { targetDate: goalDate } : {}) } : null);
        const nextNote = cat.creditCardId ? note : withGoalChange(note, cat.goal, goalObj);
        let rolloverChanges = [...(cat.rolloverChanges || [])];
        const effectiveMonth = past ? today : month;
        const cur = (cat.rolloverChanges || []).filter((c) => c.month <= effectiveMonth).sort((a, b) => b.month.localeCompare(a.month))[0]?.type || cat.rollover || "rollover";
        if (!past && rollover !== cur && goalType !== "date") {
          rolloverChanges = rolloverChanges.filter((c) => c.month !== effectiveMonth);
          rolloverChanges.push({ month: effectiveMonth, type: rollover });
        }
        const max = goalType === "savings" ? Math.max(rolloverMax, goalTarget || 0) : rolloverMax;
        ctx.updateBudget((b) => setCategory(b, { ...cat, name: titled, groupId, note: nextNote, rollover: cat.rollover || "rollover", rolloverChanges, rolloverMax: rollover === "max" ? max : 0, goal: goalObj }));
        sheet.close();
      }}));
      host.append(btn("Note for this month", { kind: "ghost", block: true, onClick: () => { sheet.close(); openNote(ctx, cat); } }));
      if (!cat.creditCardId) {
        host.append(btn(cat.archived ? "Restore" : "Archive", { kind: "ghost", block: true, onClick: () => { ctx.updateBudget((b) => archiveCategory(b, cat.id, month)); sheet.close(); } }));
        host.append(btn("Delete", { kind: "danger", block: true, onClick: () => {
          const used = (budget.transactions || []).some((t) => t.categoryId === cat.id || t.splits?.some((s) => s.categoryId === cat.id));
          if (used) { toast("This category has transactions. Archive it instead."); return; }
          confirmDialog({
            title: `Delete ${cat.name}?`,
            message: "This removes the category and its assignments. You can undo it from the top bar.",
            confirm: "Delete",
            danger: true,
            onConfirm: () => {
              ctx.updateBudget((b) => deleteCategory(b, cat.id));
              sheet.close();
              toast("Deleted", { label: "Undo", action: () => ctx.undo() });
            },
          });
        }}));
      }
      paintExtra();
    },
  });
}

function openNote(ctx, cat) {
  const month = ctx.month;
  const existing = noteOf(ctx.budget(), month, cat);
  const ta = h("textarea", { class: "input", rows: "4" });
  ta.value = existing;
  const sheet = openSheet({
    title: cat.name,
    body: (host) => {
      host.append(h("p", { class: "hint", text: `Note for ${monthLabel(month)}. Shown beside the category and on transactions in this month.` }));
      host.append(field("Month note", ta));
      if (cat.note) host.append(h("p", { class: "hint", text: cat.note }));
      host.append(btn("Save note", { block: true, onClick: () => { ctx.updateBudget((b) => setMonthNote(b, month, cat.id, ta.value)); sheet.close(); } }));
    },
  });
}

function openAddCategory(ctx) {
  const budget = ctx.budget();
  let name = "";
  let groupId = budget.categoryGroups.find((g) => g.name !== "Credit Card Payments")?.id || budget.categoryGroups[0]?.id;
  let rollover = "rollover";
  let rolloverMax = 0;
  let primed = false;
  const sheet = openSheet({
    title: "New category",
    body: (host) => {
      const paint = () => {
        const nm = textInput({ placeholder: "Groceries", value: name });
        nm.addEventListener("input", () => { name = nm.value; });
        const group = h("select", { class: "input" });
        for (const g of budget.categoryGroups) if (g.name !== "Credit Card Payments") group.append(h("option", { value: g.id, text: g.name }));
        group.value = groupId || "";
        group.addEventListener("change", () => { groupId = group.value; });
        const rolls = h("div");
        for (const [val, title, desc] of [
          ["rollover", "Roll over", "Leftover carries into next month"],
          ["return", "Return to Ready to Assign", "Leftover returns to your unassigned pool"],
          ["max", "Roll over up to a maximum", "Excess above the limit returns to Ready to Assign"],
        ]) {
          rolls.append(h("label", { class: `choice ${rollover === val ? "on" : ""}` },
            h("input", { type: "radio", name: "new-roll", value: val, checked: rollover === val, onchange: () => { rollover = val; paint(); } }),
            h("span", {}, h("strong", { text: title }), h("span", { class: "muted", text: desc })),
          ));
        }
        host.replaceChildren(field("Name", nm), field("Group", group), h("p", { class: "kicker", text: "Rollover" }), rolls);
        if (rollover === "max") host.append(field("Maximum rollover", moneyButton(rolloverMax, (n) => { rolloverMax = n; }, { label: "Maximum rollover" })));
        host.append(btn("Add", { block: true, onClick: () => {
          if (!name.trim() || !groupId) return;
          const res = addCategory(ctx.budget(), { name, groupId, rollover, rolloverMax });
          if (res.error) { toast(res.error); return; }
          ctx.updateBudget(() => res.budget);
          sheet.close();
        }}));
        if (!primed) { primed = true; nm.focus(); }
      };
      paint();
    },
  });
}

function openHistory(ctx) {
  const budget = ctx.budget();
  const series = historySeries(budget);
  const sheet = openSheet({
    title: "History",
    body: (host) => {
      const canvas = h("canvas", { class: "chart", width: "640", height: "280" });
      host.append(canvas,
        h("div", { class: "legend" },
          h("span", {}, h("i", { style: "background:var(--accent)" }), "Income"),
          h("span", {}, h("i", { style: "background:var(--danger)" }), "Spending"),
          h("span", {}, h("i", { style: "background:var(--brass)" }), "Ready to Assign"),
        ),
        h("p", { class: "hint", text: "Spending leaves out card-payment categories. The line is Ready to Assign, including when it’s negative." }));
      const list = h("div", { class: "stack" });
      for (const row of [...series].reverse()) {
        list.append(h("button", { class: "line", type: "button", onclick: () => { ctx.setMonth(row.month); sheet.close(); } },
          h("strong", { text: monthLabel(row.month) }),
          h("span", { class: "muted", text: `in ${fmt(row.income)} · out ${fmt(row.spent)}` }),
          h("span", { text: fmt(row.free) }),
        ));
      }
      host.append(list);
      requestAnimationFrame(() => drawChart(canvas, series));
    },
  });
}

function drawChart(canvas, series) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 320;
  const hgt = 180;
  canvas.width = w * dpr;
  canvas.height = hgt * dpr;
  const g = canvas.getContext("2d");
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, hgt);
  if (!series.length) return;
  const css = getComputedStyle(document.documentElement);
  const ink = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const income = ink("--accent", "#2f6f62");
  const spend = ink("--danger", "#a33b32");
  const free = ink("--brass", "#c4a574");
  const max = Math.max(1, ...series.flatMap((s) => [s.income, s.spent, Math.abs(s.free)]));
  const slot = w / series.length;
  series.forEach((s, i) => {
    const x = i * slot + slot * 0.2;
    const bw = slot * 0.25;
    const ih = (s.income / max) * (hgt - 24);
    const sh = (s.spent / max) * (hgt - 24);
    g.fillStyle = income;
    g.fillRect(x, hgt - 16 - ih, bw, ih);
    g.fillStyle = spend;
    g.fillRect(x + bw + 2, hgt - 16 - sh, bw, sh);
  });
  const anyNeg = series.some((s) => s.free < -0.005);
  const base = anyNeg ? hgt * 0.62 : hgt - 16;
  const span = anyNeg ? hgt * 0.45 : hgt - 24;
  g.strokeStyle = free;
  g.lineWidth = 2;
  g.beginPath();
  series.forEach((s, i) => {
    const x = i * slot + slot * 0.5;
    const y = Math.max(6, Math.min(hgt - 6, base - (s.free / max) * span));
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  });
  g.stroke();
}

void uid;

export function openInbox(ctx) {
  const notes = collectReminders(ctx.budget(), ctx.month);
  const sheet = openSheet({
    title: notes.length ? `${notes.length} notice${notes.length === 1 ? "" : "s"}` : "Notices",
    body: (host) => {
      if (!notes.length) host.append(h("p", { class: "empty", text: "Nothing needs you right now." }));
      for (const n of notes) {
        host.append(h("button", { class: "notice", type: "button", onclick: () => {
          sheet.close();
          if (n.kind === "overspend") {
            const mk = String(n.id || "").split(":")[1];
            if (mk) ctx.setMonth(mk);
            openCover(ctx, mk || ctx.month);
            return;
          }
          if (n.kind === "payment") {
            const id = String(n.id || "").slice("payment:".length);
            const tx = (ctx.budget().transactions || []).find((t) => t.id === id);
            if (tx) openMissingSide(ctx, tx);
            else toast("That payment is already matched");
            return;
          }
          if (n.kind === "reconcile") {
            const id = String(n.id || "").split(":")[1];
            ctx.ui.focusAccount = id;
            ctx.go("accounts");
            return;
          }
          if (n.kind === "cc" || n.kind === "goal" || n.kind === "bill" || n.kind === "rta") {
            ctx.go("budget");
            return;
          }
          const hash = String(n.url || "").replace(/^\.\//, "");
          if (hash) location.hash = hash.startsWith("#") ? hash : `#${hash}`;
        } }, h("strong", { text: n.title }), h("span", { text: n.body || "" })));
      }
    },
  });
}

function openLog(ctx) {
  const budget = ctx.budget();
  const month = ctx.month;
  const label = (type) => type === "cover" ? "Cover overspending" : type === "cover-future" ? "Cover from future months" : type === "assign" ? "Budget assignment" : "Move money";
  const when = (ts) => {
    const d = new Date(ts || 0);
    if (!ts || Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  };
  const log = [...(budget.moneyMoveLog || [])].filter((e) => e.month === month).reverse();
  openSheet({
    title: `Move history — ${monthLabel(month)}`,
    body: (host) => {
      if (!log.length) host.append(h("p", { class: "empty", text: `No moves recorded for ${monthLabel(month)}.` }));
      for (const entry of log) {
        const head = h("div", { class: "line" }, h("strong", { text: label(entry.type) }), h("span", { class: "muted", text: when(entry.ts) }));
        host.append(head);
        for (const e of entry.entries || []) {
          host.append(h("div", { class: "line" },
            h("span", { text: `${catName(budget, e.from)} → ${catName(budget, e.to)}` }),
            h("span", { class: "money pos", text: fmt(e.amount) }),
          ));
        }
      }
    },
  });
}

function openGroup(ctx, group) {
  const budget = ctx.budget();
  let name = group.name;
  const locked = group.name === "Credit Card Payments";
  const sheet = openSheet({
    title: "Group",
    body: (host) => {
      const input = textInput({ value: name });
      input.addEventListener("input", () => { name = input.value; });
      host.append(field("Name", input));
      host.append(h("div", { class: "row gap wrap" },
        btn("Up", { kind: "ghost", onClick: () => { ctx.updateBudget((b) => moveGroup(b, group.id, -1)); sheet.close(); } }),
        btn("Down", { kind: "ghost", onClick: () => { ctx.updateBudget((b) => moveGroup(b, group.id, 1)); sheet.close(); } }),
      ));
      const cats = (budget.categories || []).filter((c) => c.groupId === group.id && !c.archived);
      for (const c of cats) {
        host.append(h("div", { class: "line" }, h("span", { text: c.name }),
          h("button", { class: "quiet-link", type: "button", text: "Up", onclick: () => { ctx.updateBudget((b) => moveCategory(b, c.id, -1)); sheet.close(); openGroup(ctx, ctx.budget().categoryGroups.find((g) => g.id === group.id)); } }),
          h("button", { class: "quiet-link", type: "button", text: "Down", onclick: () => { ctx.updateBudget((b) => moveCategory(b, c.id, 1)); sheet.close(); openGroup(ctx, ctx.budget().categoryGroups.find((g) => g.id === group.id)); } }),
        ));
      }
      host.append(btn("Save", { block: true, disabled: locked, onClick: () => {
        ctx.updateBudget((b) => renameGroup(b, group.id, name));
        sheet.close();
      }}));
      if (!locked) host.append(btn("Delete group", { kind: "danger", block: true, onClick: () => {
        confirmDialog({
          title: `Delete ${group.name}?`,
          message: "Categories in this group move to Uncategorized.",
          confirm: "Delete",
          danger: true,
          onConfirm: () => { ctx.updateBudget((b) => deleteGroup(b, group.id)); sheet.close(); toast("Group deleted", { label: "Undo", action: () => ctx.undo() }); },
        });
      }}));
      host.append(btn("New group", { kind: "ghost", block: true, onClick: () => {
        const nm = textInput({ placeholder: "New group" });
        openSheet({ title: "New group", body: (h2) => {
          h2.append(field("Name", nm), btn("Add", { block: true, onClick: () => { ctx.updateBudget((b) => addGroup(b, nm.value)); toast("Group added"); } }));
        }});
      }}));
    },
  });
}

function openAllGoals(ctx) {
  const budget = ctx.budget();
  const cats = (budget.categories || []).filter((c) => !c.archived && !c.creditCardId);
  const local = {};
  for (const c of cats) local[c.id] = { type: c.goal?.type || "", target: c.goal?.target || 0, targetDate: c.goal?.targetDate || "" };
  const sheet = openSheet({
    title: "All goals",
    body: (host) => {
      host.append(h("p", { class: "lede", text: "Set a goal on any category. Nothing is saved until you tap Save all." }));
      for (const c of cats) {
        const g = local[c.id];
        const type = h("select", { class: "input" },
          h("option", { value: "", text: "No goal" }),
          h("option", { value: "monthly", text: "Monthly" }),
          h("option", { value: "date", text: "By date" }),
          h("option", { value: "savings", text: "Savings" }),
        );
        type.value = g.type;
        const extra = h("div");
        const paint = () => {
          extra.replaceChildren();
          if (!g.type) return;
          extra.append(field("Target", moneyButton(g.target, (n) => { g.target = n; })));
          if (g.type === "date") extra.append(field("Month", h("input", { class: "input", type: "month", value: g.targetDate, onchange: (e) => { g.targetDate = e.target.value; } })));
        };
        type.addEventListener("change", () => { g.type = type.value; paint(); });
        paint();
        host.append(h("div", { class: "pair" }, h("strong", { text: c.name }), type, extra));
      }
      host.append(btn("Save all", { block: true, onClick: () => {
        ctx.updateBudget((b) => ({
          ...b,
          categories: b.categories.map((c) => {
            const g = local[c.id];
            if (!g) return c;
            const goal = g.type ? { type: g.type, target: g.target || 0, ...(g.type === "date" ? { targetDate: g.targetDate } : {}) } : null;
            return { ...c, goal };
          }),
        }));
        sheet.close();
        toast("Goals saved");
      }}));
    },
  });
}
