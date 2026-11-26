import { h, btn, openSheet, field, textInput, toast, moneyButton, confirmDialog, openAmountPad } from "../ui.js?v=132";
import { fmt, monthLabel, monthKey, prevMonth, nextMonth, todayKey, toTitleCase, uid } from "../util.js?v=132";
import {
  budgetSnapshot, getGoalMetrics, trailingAvg, monthAccessible, historySeries,
  overspentMonths, available, globalFree,
} from "../calc.js?v=132";
import {
  setAssigned, moveMoney, coverOverspending, planClawback, applyClawback,
  computeMonthAssignments, applyAssignments, setCategory, addCategory, archiveCategory,
  deleteCategory, setMonthNote, addGroup, renameGroup, deleteGroup, moveGroup, moveCategory,
} from "../mutate.js?v=132";
import { collectReminders } from "../notify.js?v=132";

function noteOf(budget, month, cat) {
  return budget.categoryNotes?.[month]?.[cat.id] || "";
}

export function renderBudget(root, ctx) {
  const budget = ctx.budget();
  if (!budget) { root.append(h("p", { text: "No budget selected." })); return; }
  const month = ctx.month;
  const today = monthKey();
  const snap = budgetSnapshot(budget, month, today);
  const collapsed = ctx.ui.collapsed;

  const head = h("div", { class: "month-nav" },
    h("button", { class: "icon-btn", type: "button", "aria-label": "Previous month", text: "‹", onclick: () => ctx.setMonth(prevMonth(month)) }),
    h("button", { class: "month-label", type: "button", text: monthLabel(month), onclick: () => ctx.setMonth(today) }),
    h("button", { class: "icon-btn", type: "button", "aria-label": "Next month", text: "›", onclick: () => {
      const n = nextMonth(month);
      if (!monthAccessible(budget, n, today) && n > nextMonth(today)) { toast("Assign money in the previous month first"); return; }
      ctx.setMonth(n);
    } }),
  );
  const planLinks = h("nav", { class: "link-row", "aria-label": "Plan" },
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
    notices.append(h("button", { class: "notice", type: "button", onclick: () => { ctx.setMonth(oldest.month); openCover(ctx, oldest.month); } },
      h("strong", { text: oldest.month === month ? "Overspent this month" : `Overspent in ${monthLabel(oldest.month)}` }),
      h("span", { class: "notice-go", text: "Cover" }),
    ));
  }
  for (const cat of budget.categories || []) {
    if (cat.goal?.type !== "date" || cat.archived) continue;
    const m = getGoalMetrics(cat, snap.available[cat.id] || 0, snap.budgeted[cat.id] || 0, month);
    if (m?.expired && !m.complete) {
      notices.append(h("button", { class: "notice warn", type: "button", onclick: () => openCategory(ctx, cat) },
        h("strong", { text: cat.name }),
        h("span", { class: "notice-go", text: "Edit" }),
      ));
    }
  }

  const under = (budget.categories || []).filter((c) => {
    if (c.archived || c.creditCardId || !c.goal) return false;
    const m = getGoalMetrics(c, snap.available[c.id] || 0, snap.budgeted[c.id] || 0, month);
    return m && ((m.type === "monthly" && m.underfunded) || (m.type === "date" && !m.complete && !m.onTrack && !m.expired));
  });
  if (under.length) {
    notices.append(h("button", { class: "notice warn", type: "button", onclick: () => openAllGoals(ctx) },
      h("strong", { text: under.slice(0, 2).map((c) => c.name).join(", ") + (under.length > 2 ? "…" : "") }),
      h("span", { class: "notice-go", text: "Goals" }),
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

function categoryRow(ctx, cat, snap, month, today) {
  const budgeted = Number(snap.budgeted[cat.id] || 0);
  const activity = Number(snap.activity[cat.id] || 0);
  const avail = Number(snap.available[cat.id] || 0);
  const metrics = getGoalMetrics(cat, avail, budgeted, month);
  const avg = trailingAvg(ctx.budget(), cat.id, month);
  const note = noteOf(ctx.budget(), month, cat);
  const row = h("article", { class: `cat ${avail < -0.005 ? "over" : ""} ${cat.archived ? "archived" : ""}` });
  const title = h("button", { class: "cat-name", type: "button", text: cat.name, onclick: () => openCategory(ctx, cat) });
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
      onCommit: (val) => {
        if (!Number.isFinite(val)) return;
        const plan = planClawback(ctx.budget(), month, cat.id, val);
        if (plan.direct || (plan.ok === true && plan.direct)) {
          ctx.updateBudget((b) => setAssigned(b, month, cat.id, val));
        } else if (plan.insufficient) {
          toast("Not enough Ready to Assign, even after future months.");
        } else if (plan.ok && plan.plan) {
          confirmDialog({
            title: "Pull from future months?",
            message: plan.plan.map((p) => `${p.categoryName} in ${p.month}: ${fmt(p.amount)}`).join("\n"),
            confirm: "Move it",
            onConfirm: () => ctx.updateBudget((b) => applyClawback(b, month, plan.plan, cat.id, val)),
          });
        } else ctx.updateBudget((b) => setAssigned(b, month, cat.id, val));
      },
    });
  }});
  bBtn.append(h("span", { class: "fig-k", text: "Assigned" }), h("span", { class: "fig-n", text: fmt(budgeted) }));

  const actCls = activity > 0.005 ? "num-btn fig neg" : activity < -0.005 ? "num-btn fig pos" : "num-btn fig zero";
  const actText = activity > 0.005 || activity < -0.005 ? fmt(-activity) : fmt(0);
  const avCls = avail < -0.005 ? "num-btn avail neg" : avail > 0.005 ? "num-btn avail pos" : "num-btn avail zero";
  const bar = metrics && (metrics.type === "savings" || metrics.type === "date")
    ? h("div", { class: "goal-bar" }, h("span", { style: `width:${Math.max(0, Math.min(100, metrics.complete ? 100 : (metrics.progress != null ? metrics.progress : (metrics.target ? (avail / metrics.target) * 100 : 0))))}%` }))
    : null;

  row.append(
    h("div", { class: "cat-id" }, title, sub),
    h("button", { class: avCls, type: "button", onclick: () => {
      if (avail < -0.005) openCover(ctx, month, cat.id);
      else openMove(ctx, cat.id, null);
    } }, h("span", { class: "fig-n", text: fmt(avail) })),
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
  const sheet = openSheet({
    title: "Move money",
    body: (host) => {
      const fromSel = h("select", { class: "input" });
      const toSel = h("select", { class: "input" });
      const fill = () => {
        fromSel.replaceChildren(h("option", { value: "rta", text: `Ready to Assign (${fmt(Math.max(0, snap.free))})` }));
        toSel.replaceChildren(h("option", { value: "", text: "Select destination" }), h("option", { value: "rta", text: "Ready to Assign" }));
        for (const g of budget.categoryGroups) {
          const og1 = h("optgroup", { label: g.name });
          const og2 = h("optgroup", { label: g.name });
          for (const c of budget.categories.filter((c) => c.groupId === g.id && !c.archived)) {
            const av = snap.available[c.id] || 0;
            og1.append(h("option", { value: c.id, text: `${c.name} (${fmt(av)})`, disabled: av <= 0 }));
            if (c.id !== from) og2.append(h("option", { value: c.id, text: c.name }));
          }
          fromSel.append(og1); toSel.append(og2);
        }
        fromSel.value = from; toSel.value = to;
      };
      fill();
      fromSel.addEventListener("change", () => { from = fromSel.value; fill(); });
      toSel.addEventListener("change", () => { to = toSel.value; });
      const err = h("p", { class: "error", text: "" });
      host.append(field("From", fromSel), field("To", toSel), field("Amount", moneyButton(0, (n) => { amount = n; })), err,
        btn("Move", { block: true, onClick: () => {
          const avail = from === "rta" ? Math.max(0, snap.free) : (snap.available[from] || 0);
          if (!to || from === to || !(amount > 0)) return;
          if (amount > avail + 0.001) { err.textContent = `Only ${fmt(avail)} available.`; return; }
          ctx.updateBudget((b) => moveMoney(b, month, from === "rta" ? null : from, to === "rta" ? null : to, amount));
          sheet.close();
          toast("Money moved", { label: "Undo", action: () => ctx.undo() });
        }}));
    },
  });
}

function openCover(ctx, month, focusId, note) {
  const budget = ctx.budget();
  const overs = (budget.categories || []).filter((c) => !c.archived && !c.creditCardId && available(budget, c.id, month) < -0.005);
  if (!overs.length) { toast("Nothing overspent this month"); return; }
  const sources = [];
  const before = new Set(overspentMonths(budget, monthKey()).map((o) => o.month));
  const sheet = openSheet({
    title: "Cover overspending",
    body: (host) => {
      if (note) host.append(h("p", { class: "notice", text: note }));
      host.append(h("p", { class: "lede", text: overs.map((c) => `${c.name} ${fmt(available(budget, c.id, month))}`).join("\n") }));
      const free = globalFree(budget, month);
      const addSrc = (id, name, max) => {
        let amt = 0;
        const row = h("div", { class: "line" }, h("span", { text: name }), moneyButton(0, (n) => { amt = Math.min(n, max); const i = sources.find((s) => s.id === id); if (i) i.amount = amt; else sources.push({ id, amount: amt }); }));
        host.append(row);
      };
      if (free > 0.005) addSrc("rta", `Ready to Assign (${fmt(free)})`, free);
      for (const c of budget.categories) {
        if (c.archived || c.creditCardId) continue;
        const av = available(budget, c.id, month);
        if (av > 0.005 && !overs.some((o) => o.id === c.id)) addSrc(c.id, `${c.name} (${fmt(av)})`, av);
      }
      host.append(btn("Cover", { block: true, onClick: () => {
        const use = sources.filter((s) => s.amount > 0);
        if (!use.length) return;
        ctx.updateBudget((b) => coverOverspending(b, month, use));
        sheet.close();
        const b = ctx.budget();
        const today = monthKey();
        let mk = nextMonth(month);
        for (let i = 0; i < 24 && mk <= today; i++) {
          const still = (b.categories || []).some((c) => !c.archived && !c.creditCardId && available(b, c.id, mk) < -0.005);
          if (still) {
            const created = !before.has(mk);
            ctx.setMonth(mk);
            openCover(ctx, mk, null, created ? `Covering ${monthLabel(month)} left overspending in ${monthLabel(mk)}.` : `Still overspent in ${monthLabel(mk)}.`);
            return;
          }
          mk = nextMonth(mk);
        }
        toast("Overspending covered", { label: "Undo", action: () => ctx.undo() });
      }}));
      if (focusId) host.dataset.focus = focusId;
    },
  });
}

function expiredDateGoals(budget, month) {
  return (budget.categories || []).filter((c) => {
    if (c.archived || c.goal?.type !== "date") return false;
    const m = getGoalMetrics(c, available(budget, c.id, month), (budget.monthlyBudgets?.[month] || {})[c.id] || 0, month);
    return m?.expired && !m.complete;
  });
}

function openExpired(ctx, cats, then) {
  const choices = {};
  const sheet = openSheet({
    title: "Goals past their date",
    body: (host) => {
      host.append(h("p", { class: "lede", text: "Set a new date or remove the goal before auto-assign continues." }));
      for (const cat of cats) {
        const box = h("div", { class: "pair" });
        const date = h("input", { class: "input", type: "month", min: nextMonth(monthKey()) });
        let target = cat.goal?.target || 0;
        box.append(h("strong", { text: cat.name }), h("p", { class: "hint", text: `${fmt(cat.goal.target)} by ${cat.goal.targetDate}` }),
          field("New month", date), field("New target", moneyButton(target, (n) => { target = n; })),
          h("div", { class: "row gap wrap" },
            btn("Use new goal", { kind: "ghost", onClick: () => { if (!date.value) { toast("Pick a future month"); return; } choices[cat.id] = { date: date.value, amount: target }; toast("Noted"); } }),
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
  const expired = expiredDateGoals(budget, month);
  if (expired.length) { openExpired(ctx, expired, () => openAuto(ctx)); return; }
  runAuto(ctx, month, null);
}

function runAuto(ctx, month, carried) {
  const budget = ctx.budget();
  const result = computeMonthAssignments(budget, month, budget.monthlyBudgets || {}, budget.inflows || {});
  if (!result.assignments.length && !carried) { toast("Nothing to assign. Goals are funded, or Ready to Assign is empty."); return; }
  const amounts = {};
  result.assignments.forEach((a) => { amounts[a.categoryId] = a.amount; });
  const all = carried ? [...carried] : [];
  if (!result.assignments.length) { openSavings(ctx, month, all); return; }
  const sheet = openSheet({
    title: `Auto-assign ${monthLabel(month)}`,
    body: (host) => {
      host.append(h("p", { class: "lede", text: "Underfunded monthly and dated goals. Edit any amount before it lands." }));
      for (const a of result.assignments) {
        const cat = budget.categories.find((c) => c.id === a.categoryId);
        host.append(h("div", { class: "line" }, h("span", { text: cat?.name || "Category" }), moneyButton(a.amount, (n) => { amounts[a.categoryId] = n; })));
      }
      host.append(btn("Assign", { block: true, onClick: () => {
        ctx.updateBudget((b) => applyAssignments(b, month, amounts));
        sheet.close();
        const applied = result.assignments.map((a) => ({ ...a, amount: amounts[a.categoryId] || 0 })).filter((a) => a.amount > 0);
        openSavings(ctx, month, [...all, { month, assignments: applied }]);
      }}));
    },
  });
}

function openSavings(ctx, month, all) {
  const budget = ctx.budget();
  const left = globalFree(budget, month);
  const goals = (budget.categories || []).filter((c) => c.goal?.type === "savings" && !c.archived && !getGoalMetrics(c, available(budget, c.id, month), 0, month)?.complete);
  if (!(left > 1) || !goals.length) { offerCascade(ctx, month, all); return; }
  const amounts = {};
  const sheet = openSheet({
    title: "Savings goals",
    body: (host) => {
      host.append(h("p", { class: "lede", text: `${fmt(left)} is still Ready to Assign. Fund savings targets, or skip.` }));
      for (const g of goals) host.append(h("div", { class: "line" }, h("span", { text: g.name }), moneyButton(0, (n) => { amounts[g.id] = n; })));
      host.append(h("div", { class: "row gap" },
        btn("Skip", { kind: "ghost", onClick: () => { sheet.close(); offerCascade(ctx, month, all); } }),
        btn("Fund", { block: true, onClick: () => {
          ctx.updateBudget((b) => applyAssignments(b, month, amounts));
          sheet.close();
          const applied = Object.entries(amounts).filter(([, n]) => n > 0).map(([categoryId, amount]) => ({ categoryId, amount }));
          const bucket = all.find((a) => a.month === month);
          if (bucket) bucket.assignments.push(...applied);
          else if (applied.length) all.push({ month, assignments: applied });
          offerCascade(ctx, month, all);
        }}),
      ));
    },
  });
}

function offerCascade(ctx, month, all) {
  const budget = ctx.budget();
  const left = globalFree(budget, month);
  const hasGoals = (budget.categories || []).some((c) => c.goal && !c.archived && c.goal.type !== "savings");
  if (!(left > 1) || !hasGoals) { openRecap(all); return; }
  const fund = () => {
    ctx.updateBudget((b) => {
      let cur = b;
      let mk = nextMonth(month);
      for (let i = 0; i < 18; i++) {
        const res = computeMonthAssignments(cur, mk, cur.monthlyBudgets || {}, cur.inflows || {});
        if (!res.assignments.length) break;
        const am = {};
        res.assignments.forEach((a) => { am[a.categoryId] = a.amount; });
        cur = applyAssignments(cur, mk, am);
        mk = nextMonth(mk);
      }
      return cur;
    });
    toast("Funded later months that still had goals");
  };
  confirmDialog({
    title: "Keep assigning?",
    message: `${fmt(left)} is still Ready to Assign.`,
    confirm: "Next month",
    extra: (host) => {
      host.append(btn("Fund every later month", { kind: "quiet", block: true, onClick: () => { fund(); closeAndRecap(all); } }));
    },
    onConfirm: () => runAuto(ctx, nextMonth(month), all),
  });
}

function closeAndRecap(all) {
  document.querySelector(".scrim")?.querySelector(".icon-btn")?.click();
  openRecap(all);
}

function openRecap(all) {
  const lines = [];
  for (const block of all || []) {
    for (const a of block.assignments || []) lines.push(`${monthLabel(block.month)}: ${fmt(a.amount)}`);
  }
  if (!lines.length) { toast("Assigned"); return; }
  openSheet({
    title: "Assigned",
    body: (host) => {
      host.append(h("p", { class: "lede", text: lines.join("\n") }));
      host.append(btn("Done", { block: true, onClick: () => document.querySelector(".sheet .icon-btn")?.click() }));
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
      nt.value = note;
      nt.addEventListener("input", () => { note = nt.value; });
      host.append(field("Name", nm), field("Group", group), field("Goal", goal), goalBox, h("p", { class: "kicker", text: "Rollover" }), rollBox, field("Category note", nt));
      host.append(btn("Save", { block: true, onClick: () => {
        const titled = toTitleCase(name.trim());
        if (!titled) return;
        if (budget.categories.some((c) => c.id !== cat.id && c.name.toLowerCase() === titled.toLowerCase())) { toast("That category name already exists"); return; }
        const goalObj = goalType ? { type: goalType, target: goalTarget, ...(goalType === "date" ? { targetDate: goalDate } : {}) } : null;
        let rolloverChanges = [...(cat.rolloverChanges || [])];
        const effectiveMonth = past ? today : month;
        const cur = (cat.rolloverChanges || []).filter((c) => c.month <= effectiveMonth).sort((a, b) => b.month.localeCompare(a.month))[0]?.type || cat.rollover || "rollover";
        if (!past && rollover !== cur && goalType !== "date") {
          rolloverChanges = rolloverChanges.filter((c) => c.month !== effectiveMonth);
          rolloverChanges.push({ month: effectiveMonth, type: rollover });
        }
        const max = goalType === "savings" ? Math.max(rolloverMax, goalTarget || 0) : rolloverMax;
        ctx.updateBudget((b) => setCategory(b, { ...cat, name: titled, groupId, note, rollover: cat.rollover || "rollover", rolloverChanges, rolloverMax: rollover === "max" ? max : 0, goal: goalObj }));
        sheet.close();
      }}));
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
  const sheet = openSheet({
    title: "New category",
    body: (host) => {
      const nm = textInput({ placeholder: "Groceries" });
      nm.addEventListener("input", () => { name = nm.value; });
      const group = h("select", { class: "input" });
      for (const g of budget.categoryGroups) if (g.name !== "Credit Card Payments") group.append(h("option", { value: g.id, text: g.name }));
      group.value = groupId || "";
      group.addEventListener("change", () => { groupId = group.value; });
      host.append(field("Name", nm), field("Group", group), btn("Add", { block: true, onClick: () => {
        if (!name.trim() || !groupId) return;
        ctx.updateBudget((b) => addCategory(b, { name, groupId }).budget);
        sheet.close();
      }}));
      nm.focus();
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
  openSheet({
    title: notes.length ? `${notes.length} notice${notes.length === 1 ? "" : "s"}` : "Notices",
    body: (host) => {
      if (!notes.length) host.append(h("p", { class: "empty", text: "Nothing needs you right now." }));
      for (const n of notes) {
        host.append(h("button", { class: "notice", type: "button", onclick: () => {
          const hash = String(n.url || "").replace(/^\.\//, "");
          if (hash) location.hash = hash.startsWith("#") ? hash : `#${hash}`;
          document.querySelector(".scrim .icon-btn")?.click();
        } }, h("strong", { text: n.title }), h("span", { text: n.body || "" })));
      }
    },
  });
}

function openLog(ctx) {
  const log = [...(ctx.budget().moneyMoveLog || [])].reverse();
  openSheet({
    title: "Money moves",
    body: (host) => {
      if (!log.length) host.append(h("p", { class: "empty", text: "Moves you make will show up here." }));
      for (const entry of log.slice(0, 40)) {
        const bits = (entry.entries || []).map((e) => `${fmt(e.amount)}`).join(", ");
        host.append(h("div", { class: "line" }, h("span", {}, h("strong", { text: entry.type || "move" }), h("span", { class: "muted", text: ` ${entry.month || ""}` })), h("span", { text: bits })));
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
