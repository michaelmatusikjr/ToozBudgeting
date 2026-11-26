import { h, btn, openSheet, field, textInput, toast, moneyButton, confirmDialog } from "../ui.js";
import { fmt, monthLabel, monthKey, prevMonth, nextMonth, todayKey, toTitleCase, uid } from "../util.js";
import {
  budgetSnapshot, getGoalMetrics, trailingAvg, monthAccessible, historySeries,
  overspentMonths, available, globalFree,
} from "../calc.js";
import {
  setAssigned, moveMoney, coverOverspending, planClawback, applyClawback,
  computeMonthAssignments, applyAssignments, setCategory, addCategory, archiveCategory,
  deleteCategory, setMonthNote,
} from "../mutate.js";

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

  const head = h("header", { class: "view-head" },
    h("div", { class: "month-nav" },
      h("button", { class: "icon-btn", type: "button", "aria-label": "Previous month", text: "‹", onclick: () => ctx.setMonth(prevMonth(month)) }),
      h("button", { class: "month-label", type: "button", text: monthLabel(month), onclick: () => ctx.setMonth(today) }),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Next month", text: "›", onclick: () => {
        const n = nextMonth(month);
        if (!monthAccessible(budget, n, today) && n > nextMonth(today)) { toast("Assign money in the previous month first"); return; }
        ctx.setMonth(n);
      } }),
    ),
    h("div", { class: "head-actions" },
      h("button", { class: "icon-btn", type: "button", "aria-label": "History", text: "History", onclick: () => openHistory(ctx) }),
      h("button", { class: "icon-btn", type: "button", "aria-label": "Move money", text: "Move", onclick: () => openMove(ctx, null, null) }),
    ),
  );

  const rtaClass = snap.free < -0.005 ? "rta bad" : snap.free < 0.005 ? "rta zero" : "rta";
  const rta = h("section", { class: rtaClass },
    h("p", { class: "kicker", text: "Ready to Assign" }),
    h("p", { class: "rta-num", text: fmt(snap.free) }),
    h("p", { class: "muted", text: month === today ? `This month ${fmt(snap.rta)} · ${fmt(snap.ahead)} assigned ahead` : `Showing ${monthLabel(month)}` }),
  );

  const overs = overspentMonths(budget, today).filter((o) => o.month <= today);
  const notices = h("div", { class: "notices" });
  if (overs.length) {
    const oldest = overs[0];
    notices.append(h("button", { class: "notice", type: "button", onclick: () => { ctx.setMonth(oldest.month); openCover(ctx, oldest.month); } },
      h("strong", { text: "Overspending" }),
      h("span", { text: oldest.month === month ? "Cover it in this month." : `Start with ${monthLabel(oldest.month)}.` }),
    ));
  }
  for (const cat of budget.categories || []) {
    if (cat.goal?.type !== "date" || cat.archived) continue;
    const m = getGoalMetrics(cat, snap.available[cat.id] || 0, snap.budgeted[cat.id] || 0, month);
    if (m?.expired && !m.complete) {
      notices.append(h("button", { class: "notice warn", type: "button", onclick: () => openCategory(ctx, cat) },
        h("strong", { text: cat.name }),
        h("span", { text: "Date goal has passed." }),
      ));
    }
  }

  const tools = h("div", { class: "row gap wrap" },
    btn("Auto-assign", { kind: "ghost", onClick: () => openAuto(ctx) }),
    btn("Cover overspending", { kind: "ghost", onClick: () => openCover(ctx, month) }),
    btn("Add category", { kind: "quiet", onClick: () => openAddCategory(ctx) }),
  );

  const groups = h("div", { class: "groups" });
  for (const g of budget.categoryGroups || []) {
    const cats = (budget.categories || []).filter((c) => c.groupId === g.id && (ctx.ui.showArchived || !c.archived));
    if (!cats.length && g.name === "Uncategorized") continue;
    const open = !collapsed[g.id];
    const gBudgeted = cats.reduce((s, c) => s + Number(snap.budgeted[c.id] || 0), 0);
    const gActivity = cats.reduce((s, c) => s + Number(snap.activity[c.id] || 0), 0);
    const gAvail = cats.reduce((s, c) => s + Number(snap.available[c.id] || 0), 0);
    const sec = h("section", { class: "group" });
    sec.append(h("button", { class: "group-h", type: "button", onclick: () => { collapsed[g.id] = !collapsed[g.id]; ctx.render(); } },
      h("span", { class: "chev", text: open ? "▾" : "▸" }),
      h("span", { class: "grow", text: g.name }),
      h("span", { class: "num", text: fmt(gAvail) }),
    ));
    if (open) {
      sec.append(h("div", { class: "cols" }, h("span", { text: "Budgeted" }), h("span", { text: "Activity" }), h("span", { text: "Available" })));
      for (const cat of cats) sec.append(categoryRow(ctx, cat, snap, month, today));
      sec.append(h("div", { class: "group-foot muted", text: `${fmt(gBudgeted)} budgeted · ${fmt(gActivity)} activity` }));
    }
    groups.append(sec);
  }

  root.append(head, rta, notices, tools, groups);
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
  const meta = h("div", { class: "cat-meta" });
  if (metrics) {
    const label = metrics.type === "monthly"
      ? (metrics.underfunded ? `Underfunded ${fmt(metrics.needed)}` : "Funded")
      : metrics.type === "date"
        ? (metrics.complete ? "Goal reached" : `${fmt(metrics.monthlyNeeded)} / mo · ${metrics.monthsLeft} mo`)
        : `${Math.round(metrics.progress)}% of ${fmt(metrics.target)}`;
    meta.append(h("span", { class: "pill", text: label }));
  }
  if (note || cat.note) meta.append(h("button", { class: "pill", type: "button", text: "Note", onclick: () => openNote(ctx, cat) }));
  if (avg && ctx.ui.avg === cat.id) meta.append(h("span", { class: "pill", text: `Avg ${fmt(avg.avg)} · ${avg.monthsUsed} mo` }));

  const bBtn = h("button", { class: "num-btn", type: "button", text: fmt(budgeted), onclick: () => {
    if (cat.creditCardId) { toast("Card payment categories are funded by charges"); return; }
    const input = h("input", { class: "input num-edit", inputmode: "decimal", value: String(budgeted) });
    const sheet = openSheet({
      title: cat.name,
      body: (host) => {
        host.append(field("Budgeted this month", input));
        if (avg) host.append(h("p", { class: "hint", text: `Recent average spend ${fmt(avg.avg)}.` }));
        host.append(btn("Save", { block: true, onClick: () => {
          const val = Math.round(parseFloat(input.value) * 100) / 100;
          if (!Number.isFinite(val)) return;
          const plan = planClawback(ctx.budget(), month, cat.id, val);
          sheet.close();
          if (plan.direct || plan.ok === true && plan.direct) {
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
        }}));
      },
    });
    input.focus();
  }});

  row.append(
    h("div", { class: "cat-top" }, title, h("button", { class: "quiet-link", type: "button", text: "avg", onclick: () => { ctx.ui.avg = ctx.ui.avg === cat.id ? null : cat.id; ctx.render(); } })),
    meta,
    h("div", { class: "cat-nums" },
      bBtn,
      h("button", { class: "num-btn", type: "button", text: fmt(activity), onclick: () => ctx.go("transactions", { categoryId: cat.id, month }) }),
      h("button", { class: `num-btn avail ${avail < -0.005 ? "bad" : ""}`, type: "button", text: fmt(avail), onclick: () => {
        if (avail < -0.005) openCover(ctx, month, cat.id);
        else openMove(ctx, cat.id, null);
      }}),
    ),
  );
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

function openCover(ctx, month, focusId) {
  const budget = ctx.budget();
  const overs = (budget.categories || []).filter((c) => !c.archived && !c.creditCardId && available(budget, c.id, month) < -0.005);
  if (!overs.length) { toast("Nothing overspent this month"); return; }
  const sources = [];
  const sheet = openSheet({
    title: "Cover overspending",
    body: (host) => {
      host.append(h("p", { class: "lede", text: overs.map((c) => `${c.name} ${fmt(available(budget, c.id, month))}`).join(" · ") }));
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
        toast("Overspending covered", { label: "Undo", action: () => ctx.undo() });
      }}));
      if (focusId) host.dataset.focus = focusId;
    },
  });
}

function openAuto(ctx) {
  const budget = ctx.budget();
  const month = ctx.month;
  const result = computeMonthAssignments(budget, month, budget.monthlyBudgets || {}, budget.inflows || {});
  if (!result.assignments.length) { toast("Nothing to assign. Goals are funded, or Ready to Assign is empty."); return; }
  const amounts = {};
  result.assignments.forEach((a) => { amounts[a.categoryId] = a.amount; });
  const sheet = openSheet({
    title: "Auto-assign",
    body: (host) => {
      host.append(h("p", { class: "lede", text: "Underfunded monthly and dated goals, in order. Edit any amount." }));
      for (const a of result.assignments) {
        const cat = budget.categories.find((c) => c.id === a.categoryId);
        host.append(h("div", { class: "line" }, h("span", { text: cat?.name || "Category" }), moneyButton(a.amount, (n) => { amounts[a.categoryId] = n; })));
      }
      host.append(btn("Assign", { block: true, onClick: () => {
        ctx.updateBudget((b) => applyAssignments(b, month, amounts));
        sheet.close();
        const left = globalFree(ctx.budget(), month);
        if (left > 1) {
          confirmDialog({
            title: "Keep assigning?",
            message: `${fmt(left)} is still Ready to Assign. Fund the next month with the same goals?`,
            confirm: "Fund next month",
            onConfirm: () => {
              const b = ctx.budget();
              const n = computeMonthAssignments(b, nextMonth(month), b.monthlyBudgets || {}, b.inflows || {});
              const am = {};
              n.assignments.forEach((a) => { am[a.categoryId] = a.amount; });
              if (n.assignments.length) ctx.updateBudget((bb) => applyAssignments(bb, nextMonth(month), am));
              else toast("Next month has nothing to fund");
            },
          });
        } else toast("Assigned");
      }}));
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
          ctx.updateBudget((b) => deleteCategory(b, cat.id));
          sheet.close();
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
      host.append(canvas, h("p", { class: "hint", text: "Income, spending (excluding card payments), and Ready to Assign." }));
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
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 320;
  const hgt = 180;
  canvas.width = w * dpr;
  canvas.height = hgt * dpr;
  const g = canvas.getContext("2d");
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, hgt);
  if (!series.length) return;
  const max = Math.max(1, ...series.flatMap((s) => [s.income, s.spent, Math.abs(s.free)]));
  const slot = w / series.length;
  series.forEach((s, i) => {
    const x = i * slot + slot * 0.2;
    const bw = slot * 0.25;
    const ih = (s.income / max) * (hgt - 24);
    const sh = (s.spent / max) * (hgt - 24);
    g.fillStyle = "#2f6f62";
    g.fillRect(x, hgt - 16 - ih, bw, ih);
    g.fillStyle = "#a33b32";
    g.fillRect(x + bw + 2, hgt - 16 - sh, bw, sh);
  });
  g.strokeStyle = "#c4a574";
  g.lineWidth = 2;
  g.beginPath();
  series.forEach((s, i) => {
    const x = i * slot + slot * 0.5;
    const y = hgt - 16 - (Math.max(0, s.free) / max) * (hgt - 24);
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  });
  g.stroke();
}

void uid;
