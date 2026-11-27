import { h, btn, openSheet, field, textInput, toast, moneyButton, confirmDialog, openAmountPad, isTouchUi, amountInput, bindContextMenu, btnRow } from "../ui.js?v=154";
import { fmt, monthLabel, monthKey, prevMonth, nextMonth, todayKey, toTitleCase, uid, round2 } from "../util.js?v=154";
import {
  budgetSnapshot, getGoalMetrics, trailingAvg, monthAccessible, historySeries,
  overspentMonths, available, globalFree, ccMismatches, catReturned,
} from "../calc.js?v=154";
import {
  setAssigned, moveMoney, coverOverspending, planClawback, applyClawback,
  computeMonthAssignments, applyAssignments, setCategory, addCategory, archiveCategory,
  deleteCategory, setMonthNote, addGroup, renameGroup, deleteGroup, moveGroup, moveCategory,
  placeGroup, placeCategory,
} from "../mutate.js?v=154";
import { collectReminders } from "../notify.js?v=154";
import { openMissingSide, openTx } from "./transactions.js?v=154";

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


function showActivityCol() {
  return !isTouchUi();
}

function budgetGridClass() {
  return showActivityCol() ? "bud-grid has-activity" : "bud-grid";
}

function goalMetricsFor(cat, snap, month) {
  const avail = Number(snap.available[cat.id] || 0);
  const budgeted = Number(snap.budgeted[cat.id] || 0);
  return getGoalMetrics(cat, avail, budgeted, month);
}

function openGoalCategories(budget, snap, month) {
  return (budget.categories || []).filter((cat) => {
    if (!cat.goal?.type || cat.archived) return false;
    const m = goalMetricsFor(cat, snap, month);
    if (!m) return false;
    if (m.type === "savings") return !m.complete;
    if (m.type === "monthly") return m.underfunded;
    if (m.type === "date") return !m.onTrack;
    return false;
  });
}

function underfundedGoalCats(budget, snap, month) {
  return (budget.categories || []).filter((cat) => {
    if (!cat.goal?.type || cat.archived) return false;
    const m = goalMetricsFor(cat, snap, month);
    if (!m || m.complete) return false;
    return (m.type === "monthly" && m.underfunded) || (m.type === "date" && !m.onTrack);
  });
}

function totalGoalNeeded(cats, snap, month) {
  return cats.reduce((s, cat) => {
    const m = goalMetricsFor(cat, snap, month);
    if (!m) return s;
    if (m.type === "monthly") return s + m.needed;
    if (m.type === "date") return s + Math.max(0, m.monthlyNeeded - Number(snap.budgeted[cat.id] || 0));
    return s;
  }, 0);
}

function tile(kind, icon, label, onClick) {
  return h("button", { class: `bud-tile ${kind}`, type: "button", onclick: onClick },
    h("span", { class: "bud-tile-ico", text: icon }),
    h("span", { class: "bud-tile-lbl", text: label }),
  );
}


const ROLLOVER_OPTS = [
  { value: "rollover", title: "Roll Over", desc: "Leftover carries into next month" },
  { value: "return", title: "Return to Ready to Assign", desc: "Leftover returns to your unassigned pool" },
  { value: "max", title: "Roll Over up to a Maximum", desc: "Excess above the limit returns to Ready to Assign" },
];
const GOAL_TYPES = [
  { value: "", label: "No goal", desc: "" },
  { value: "savings", label: "💰 Savings Target", desc: "Save toward a total amount" },
  { value: "monthly", label: "📅 Monthly Funding", desc: "Fund by a set amount each month" },
  { value: "date", label: "🏁 Target by Date", desc: "Reach a total amount by a specific date" },
];

function optCard({ name, value, checked, disabled, title, desc, onChange }) {
  return h("label", { class: `opt-card${checked ? " on" : ""}${disabled ? " disabled" : ""}` },
    h("input", { type: "radio", name, value, checked: !!checked, disabled: !!disabled, onchange: () => { if (!disabled) onChange(value); } }),
    h("div", {},
      h("div", { class: "opt-title", text: title }),
      desc ? h("div", { class: "opt-desc", text: desc }) : null,
    ),
  );
}

function errLine(text) {
  return text ? h("div", { class: "form-error", text }) : null;
}

function openAddGroup(ctx) {
  const budget = ctx.budget();
  let name = "";
  let nameError = "";
  const sheet = openSheet({
    title: "New Category Group",
    closeLabel: "Discard",
    body: (host) => {
      const paint = () => {
        const nm = textInput({ placeholder: "e.g. Kids, Business, Medical...", value: name });
        nm.addEventListener("input", () => { name = nm.value; nameError = ""; });
        host.replaceChildren(
          field("Group Name", nm),
          errLine(nameError),
          btnRow(
            { label: "Cancel", kind: "ghost", onClick: () => sheet.close() },
            { label: "Add Group", onClick: () => {
              if (!name.trim()) return;
              if ((ctx.budget().categoryGroups || []).some((g) => g.name.toLowerCase() === name.trim().toLowerCase())) {
                nameError = `A group named "${name.trim()}" already exists. Choose a different name.`;
                paint();
                return;
              }
              ctx.updateBudget((b) => addGroup(b, name));
              sheet.close();
            }, disabled: !name.trim() },
          ),
        );
        nm.focus();
      };
      paint();
    },
  });
}


function monthDateRange(mk) {
  const [y, m] = mk.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${mk}-01`, to: `${mk}-${String(last).padStart(2, "0")}` };
}

function fmtActivity(activity) {
  const n = Number(activity) || 0;
  const sign = n > 0 ? "-" : n < 0 ? "+" : "";
  return sign + fmt(Math.abs(n));
}

function activityClass(activity) {
  const n = Number(activity) || 0;
  if (n > 0.005) return "neg";
  if (n < -0.005) return "pos";
  return "zero";
}

function availableClass(avail) {
  if (avail < -0.005) return "neg";
  if (avail > 0.005) return "pos";
  return "zero";
}

function goMonthActivity(ctx, extra) {
  const r = monthDateRange(ctx.month);
  ctx.ui.txFilter = { dateFrom: r.from, dateTo: r.to, ...extra };
  ctx.go("transactions");
}

function openNotePeek(ctx, cat, monthNote, persistentNote) {
  const touch = window.matchMedia?.("(hover: none)")?.matches || isTouchUi();
  if (touch) {
    openSheet({
      title: `📝 ${cat.name}`,
      closeLabel: "Discard",
      body: (host) => {
        if (monthNote) {
          host.append(h("div", { class: "bud-note-k", text: "This Month" }));
          host.append(h("div", { class: "bud-note-v", text: monthNote }));
        }
        if (persistentNote) {
          host.append(h("div", { class: "bud-note-k", text: "Category" }));
          host.append(h("div", { class: "bud-note-v", text: persistentNote }));
        }
      },
    });
    return;
  }
}


function sortKey(a, b) {
  const as = Number.isFinite(a.sort) ? a.sort : 0;
  const bs = Number.isFinite(b.sort) ? b.sort : 0;
  if (as !== bs) return as - bs;
  return String(a.id || "").localeCompare(String(b.id || ""));
}

const drag = { pending: null, info: null, drop: null, preCollapsed: null, ctx: null, bound: false };

function clearDragStyle() {
  document.documentElement.style.touchAction = "";
  document.body.style.touchAction = "";
  document.body.style.userSelect = "";
  document.body.style.webkitUserSelect = "";
}

function clearDrag() {
  drag.pending = null;
  drag.info = null;
  drag.drop = null;
  drag.preCollapsed = null;
  clearDragStyle();
}

function bindReorderListeners(ctx) {
  drag.ctx = ctx;
  if (drag.bound) return;
  drag.bound = true;
  const THRESH = 8;
  const pointOf = (e) => (e.touches ? e.touches[0] : e);
  const onMove = (e) => {
    const ctxNow = drag.ctx;
    if (!ctxNow) return;
    if (drag.info) {
      e.preventDefault?.();
      const point = pointOf(e);
      if (!point) return;
      const el = document.elementFromPoint(point.clientX, point.clientY);
      const budget = ctxNow.budget();
      if (drag.info.type === "category") {
        const catEl = el?.closest("[data-dnd-cat]");
        const hdrEl = el?.closest("[data-dnd-grouphdr]");
        if (catEl) {
          const rect = catEl.getBoundingClientRect();
          const groupId = catEl.dataset.dndGroup;
          const catId = catEl.dataset.dndCat;
          let beforeId = catId;
          if (point.clientY > rect.top + rect.height / 2) {
            const groupCats = (budget.categories || []).filter((c) => c.groupId === groupId && !c.archived).sort(sortKey);
            const idx = groupCats.findIndex((c) => c.id === catId);
            beforeId = groupCats[idx + 1]?.id || null;
          }
          const next = { groupId, beforeId };
          if (drag.drop?.groupId !== next.groupId || drag.drop?.beforeId !== next.beforeId) {
            drag.drop = next;
            ctxNow.render();
          }
        } else if (hdrEl) {
          const groupId = hdrEl.dataset.dndGrouphdr;
          const groupCats = (budget.categories || []).filter((c) => c.groupId === groupId && !c.archived).sort(sortKey);
          const next = { groupId, beforeId: groupCats[0]?.id || null };
          if (drag.drop?.groupId !== next.groupId || drag.drop?.beforeId !== next.beforeId) {
            drag.drop = next;
            ctxNow.render();
          }
        }
      } else if (drag.info.type === "group") {
        const hdrEl = el?.closest("[data-dnd-grouphdr]");
        if (hdrEl) {
          const rect = hdrEl.getBoundingClientRect();
          const groupId = hdrEl.dataset.dndGrouphdr;
          let beforeGroupId = groupId;
          if (point.clientY > rect.top + rect.height / 2) {
            const groups = [...(budget.categoryGroups || [])].sort(sortKey);
            const idx = groups.findIndex((g) => g.id === groupId);
            beforeGroupId = groups[idx + 1]?.id || null;
          }
          if (drag.drop?.beforeGroupId !== beforeGroupId) {
            drag.drop = { beforeGroupId };
            ctxNow.render();
          }
        }
      }
    } else if (drag.pending) {
      e.preventDefault?.();
      const point = pointOf(e);
      if (!point) return;
      const dx = Math.abs(point.clientX - drag.pending.startX);
      const dy = Math.abs(point.clientY - drag.pending.startY);
      if (dx > THRESH || dy > THRESH) {
        const { type, id } = drag.pending;
        if (type === "group") {
          drag.preCollapsed = { ...ctxNow.ui.collapsed };
          const all = {};
          for (const g of ctxNow.budget().categoryGroups || []) all[g.id] = true;
          ctxNow.ui.collapsed = all;
        }
        document.body.style.userSelect = "none";
        document.body.style.webkitUserSelect = "none";
        drag.info = { type, id };
        drag.pending = null;
        ctxNow.render();
      }
    }
  };
  const onUp = () => {
    const ctxNow = drag.ctx;
    if (drag.info && ctxNow) {
      const { type, id } = drag.info;
      const dt = drag.drop;
      if (dt) {
        if (type === "category") ctxNow.updateBudget((b) => placeCategory(b, id, dt.groupId, dt.beforeId));
        else ctxNow.updateBudget((b) => placeGroup(b, id, dt.beforeGroupId));
      }
      if (type === "group" && drag.preCollapsed) ctxNow.ui.collapsed = drag.preCollapsed;
      const again = drag.ctx;
      clearDrag();
      drag.ctx = again;
      ctxNow.render();
    } else {
      clearDragStyle();
      drag.pending = null;
    }
  };
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("touchmove", onMove, { passive: false });
  window.addEventListener("touchend", onUp);
}

function bindDragHandle(el, type, id) {
  const start = (e) => {
    if (e.button != null && e.button !== 0) return;
    e.stopPropagation();
    const pt = e.touches ? e.touches[0] : e;
    if (!pt) return;
    drag.pending = { type, id, startX: pt.clientX, startY: pt.clientY };
    if (e.touches) {
      document.documentElement.style.touchAction = "none";
      document.body.style.touchAction = "none";
    }
  };
  el.addEventListener("mousedown", start);
  el.addEventListener("touchstart", start, { passive: true });
}

export function renderBudget(root, ctx) {
  const budget = ctx.budget();
  if (!budget) { root.append(h("p", { text: "No budget selected." })); return; }
  const month = ctx.month;
  const today = monthKey();
  const snap = budgetSnapshot(budget, month, today);
  const collapsed = ctx.ui.collapsed;
  const reorder = !!ctx.ui.reorderMode;
  if (reorder) bindReorderListeners(ctx);
  const ro = ctx.readOnly();
  const showAct = showActivityCol();
  const showAssign = snap.free > 0 && openGoalCategories(budget, snap, month).length > 0;
  const showHistory = (budget.moneyMoveLog || []).some((e) => e.month === month);
  const underfunded = underfundedGoalCats(budget, snap, month);
  const needed = totalGoalNeeded(underfunded, snap, month);
  const totalBudgeted = Object.values(snap.budgeted).reduce((s, v) => s + Number(v), 0);
  const totalActivity = Object.values(snap.activity).reduce((s, v) => s + Number(v), 0);
  const totalAvailable = (budget.categories || []).reduce((s, c) => s + Number(snap.available[c.id] || 0), 0);

  const tiles = h("div", { class: "bud-tiles" });
  if (!ro) {
    tiles.append(
      tile("txn", "＋", "Txn", () => openTx(ctx, null)),
      tile("cat", "＋", "Category", () => openAddCategory(ctx)),
      tile("grp", "＋", "Group", () => openAddGroup(ctx)),
      tile("goals", "🎯", "Goals", () => openAllGoals(ctx)),
    );
    if (showAssign) tiles.append(tile("assign", "✨", "Assign", () => openAuto(ctx)));
  }
  if (showHistory) tiles.append(tile("history", "📋", "History", () => openLog(ctx)));

  const banner = underfunded.length
    ? h("div", { class: "bud-underfund" },
      h("strong", { text: `⚠️ ${underfunded.length} goal${underfunded.length !== 1 ? "s" : ""} need${underfunded.length === 1 ? "s" : ""} funding` }),
      h("span", { class: "bud-needed", text: `· ${fmt(needed)} still needed` }),
    )
    : null;

  const reorderBar = ro ? null : h("div", { class: "bud-reorder-bar" },
    h("button", {
      class: reorder ? "bud-reorder on" : "bud-reorder",
      type: "button",
      text: reorder ? "✓ Done" : "↕ Reorder",
      onclick: () => {
        ctx.ui.reorderMode = !ctx.ui.reorderMode;
        ctx.ui.avgHintCatId = null;
        if (!ctx.ui.reorderMode) clearDrag();
        ctx.render();
      },
    }),
  );

  const cols = h("div", { class: budgetGridClass() + " bud-cols" },
    h("span", { text: "Category" }),
    h("span", { text: "Budgeted" }),
    showAct ? h("span", { text: "Activity" }) : null,
    h("span", { text: "Available" }),
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

  const groups = h("div", { class: "bud-groups" });
  for (const g of [...(budget.categoryGroups || [])].sort(sortKey)) {
    const cats = (budget.categories || []).filter((c) => c.groupId === g.id && !c.archived).sort(sortKey);
    if (!cats.length && g.name === "Uncategorized") continue;
    const open = !collapsed[g.id];
    const gB = cats.reduce((s, c) => s + Number(snap.budgeted[c.id] || 0), 0);
    const gA = cats.reduce((s, c) => s + Number(snap.activity[c.id] || 0), 0);
    const gAv = cats.reduce((s, c) => s + Number(snap.available[c.id] || 0), 0);
    const sec = h("section", { class: "bud-group" });
    const isDraggedGroup = reorder && drag.info?.type === "group" && drag.info.id === g.id;
    const groupDropBefore = reorder && drag.info?.type === "group" && drag.drop?.beforeGroupId === g.id;
    const visibleGroups = [...(budget.categoryGroups || [])].sort(sortKey).filter((gg) => {
      const c2 = (budget.categories || []).filter((c) => c.groupId === gg.id && !c.archived);
      return !(c2.length === 0 && gg.name === "Uncategorized");
    });
    const lastG = visibleGroups[visibleGroups.length - 1]?.id;
    const groupDropAfter = reorder && drag.info?.type === "group" && drag.drop?.beforeGroupId == null && g.id === lastG;
    const catDropInEmpty = reorder && drag.info?.type === "category" && drag.drop?.groupId === g.id && cats.length === 0;
    const gHead = h("div", {
      class: "bud-group-h " + budgetGridClass() + (reorder ? " reorder" : "") + (isDraggedGroup ? " dragging" : "") + (groupDropBefore || catDropInEmpty ? " drop-before" : "") + (groupDropAfter ? " drop-after" : ""),
      "data-dnd-grouphdr": g.id,
    });
    const nameBtn = h("button", {
      class: "bud-group-name",
      type: "button",
      onclick: () => { if (reorder) return; collapsed[g.id] = !collapsed[g.id]; ctx.render(); },
    }, h("span", { class: "bud-chev", text: open ? "▼" : "▶" }), g.name);
    gHead.append(nameBtn);
    gHead.append(h("div", { class: `bud-gval ${gB ? "" : "zero"}`, text: fmt(gB) }));
    if (showAct) {
      const actEl = h("div", {
        class: `bud-gval ${activityClass(gA)}`,
        text: fmtActivity(gA),
      });
      if (Math.abs(gA) > 0.005 && !reorder) {
        actEl.classList.add("linkish");
        actEl.addEventListener("click", (e) => { e.stopPropagation(); goMonthActivity(ctx, { groupId: g.id }); });
      }
      gHead.append(actEl);
    }
    gHead.append(h("div", { class: `bud-gval avail ${availableClass(gAv)}`, text: fmt(gAv) }));
    if (reorder) bindDragHandle(gHead, "group", g.id);
    else bindContextMenu(gHead, () => [
      { label: "✏️ Edit Group", edit: true, onClick: () => openGroup(ctx, g) },
    ], { readOnly: ro });
    sec.append(gHead);
    if (open) {
      for (const cat of cats) sec.append(categoryRow(ctx, cat, snap, month, today));
    }
    groups.append(sec);
  }

  const archivedCats = (budget.categories || []).filter((c) => c.archived);
  const archivedBox = h("div", { class: "bud-archived" });
  if (archivedCats.length) {
    archivedBox.append(h("button", {
      class: "bud-archived-h",
      type: "button",
      onclick: () => { ctx.ui.showArchived = !ctx.ui.showArchived; ctx.render(); },
    }, h("span", { class: "bud-chev", text: ctx.ui.showArchived ? "▼" : "▶" }), `🗂️ Archived (${archivedCats.length})`));
    if (ctx.ui.showArchived) {
      for (const cat of archivedCats) {
        archivedBox.append(h("div", { class: "bud-archived-row" },
          h("span", { text: cat.name }),
          ro ? null : h("button", {
            class: "bud-restore",
            type: "button",
            text: "↩ Restore",
            onclick: () => ctx.updateBudget((b) => archiveCategory(b, cat.id, month)),
          }),
        ));
      }
    }
  }

  const actSign = totalActivity < 0 ? "+" : "-";
  const totals = h("div", { class: "bud-totals" },
    h("div", { class: "bud-totals-row" },
      h("div", { class: "bud-tot" },
        h("span", { class: "bud-tot-k", text: "Budgeted " }),
        h("span", { class: "bud-tot-n", text: fmt(totalBudgeted) }),
      ),
      showAct ? h("div", { class: "bud-tot mid" },
        h("span", { class: "bud-tot-k", text: "Activity " }),
        h("span", { class: `bud-tot-n ${totalActivity < 0 ? "in" : "out"}`, text: `${actSign}${fmt(Math.abs(totalActivity))}` }),
      ) : null,
      h("div", { class: "bud-tot end" },
        h("span", { class: "bud-tot-k", text: "Available " }),
        h("span", { class: "bud-tot-n", text: fmt(totalAvailable) }),
      ),
    ),
  );

  root.append(h("div", { class: "bud-view" }, tiles, banner, reorderBar, cols, notices, groups, archivedBox, totals));
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
  const budget = ctx.budget();
  const budgeted = Number(snap.budgeted[cat.id] || 0);
  const activity = Number(snap.activity[cat.id] || 0);
  const avail = Number(snap.available[cat.id] || 0);
  const metrics = getGoalMetrics(cat, avail, budgeted, month);
  const monthNote = noteOf(budget, month, cat);
  const persistentNote = cat.note || "";
  const hasNote = !!(monthNote || persistentNote);
  const returned = catReturned(budget, cat, month, budget.monthlyBudgets || {}, budget.inflows || {});
  const ro = ctx.readOnly();
  const showAct = showActivityCol();
  const hintOn = ctx.ui.avgHintCatId === cat.id;
  const reorder = !!ctx.ui.reorderMode;
  const isDragged = reorder && drag.info?.type === "category" && drag.info.id === cat.id;
  const groupCats = (ctx.budget().categories || []).filter((c) => c.groupId === cat.groupId && !c.archived).sort(sortKey);
  const isLast = groupCats[groupCats.length - 1]?.id === cat.id;
  const dropBefore = reorder && drag.info?.type === "category" && drag.drop?.groupId === cat.groupId && drag.drop?.beforeId === cat.id;
  const dropAfter = reorder && drag.info?.type === "category" && drag.drop?.groupId === cat.groupId && drag.drop?.beforeId == null && isLast;

  const wrap = h("div", {
    class: "bud-cat" + (reorder ? " reorder" : "") + (isDragged ? " dragging" : "") + (dropBefore ? " drop-before" : "") + (dropAfter ? " drop-after" : ""),
    "data-dnd-cat": cat.id,
    "data-dnd-group": cat.groupId,
  });
  const row = h("div", { class: "bud-cat-row " + budgetGridClass() });

  const nameCell = h("div", { class: "bud-cat-name" });
  const nameBtn = h("button", {
    class: "bud-cat-label",
    type: "button",
    text: cat.name,
    onclick: () => {
      if (reorder || cat.creditCardId) return;
      ctx.ui.avgHintCatId = hintOn ? null : cat.id;
      ctx.render();
    },
  });
  nameCell.append(nameBtn);
  if (hasNote) {
    const ico = h("span", { class: "bud-note-ico", text: "📝", role: "button", tabindex: "0" });
    const showTip = () => {
      if (window.matchMedia?.("(hover: none)")?.matches || isTouchUi()) {
        openNotePeek(ctx, cat, monthNote, persistentNote);
        return;
      }
      ico.querySelector(".bud-note-tip")?.remove();
      const tip = h("div", { class: "bud-note-tip" });
      if (monthNote) {
        tip.append(h("div", { class: "bud-note-k", text: "THIS MONTH" }));
        tip.append(h("div", { class: "bud-note-v", text: monthNote }));
      }
      if (persistentNote) {
        tip.append(h("div", { class: "bud-note-k", text: "CATEGORY" }));
        tip.append(h("div", { class: "bud-note-v", text: persistentNote }));
      }
      ico.append(tip);
    };
    const hideTip = (e) => {
      if (e && e.relatedTarget && ico.contains(e.relatedTarget)) return;
      ico.querySelector(".bud-note-tip")?.remove();
    };
    ico.addEventListener("click", (e) => { e.stopPropagation(); showTip(); });
    ico.addEventListener("mouseenter", () => { if (!(window.matchMedia?.("(hover: none)")?.matches || isTouchUi())) showTip(); });
    ico.addEventListener("mouseleave", hideTip);
    nameCell.append(ico);
  }
  if (cat.goal?.type && !metrics?.complete) nameCell.append(h("span", { class: "bud-ico", text: "🎯" }));
  if (metrics?.complete) nameCell.append(h("span", { class: "bud-ico", text: "✅" }));
  if (metrics?.type === "monthly") {
    nameCell.append(h("span", { class: `bud-goal-m ${metrics.underfunded ? "warn" : "ok"}`, text: metrics.underfunded ? `⚠️ ${fmt(metrics.needed)}` : "✓" }));
  }
  if (metrics?.type === "date" && !metrics.complete) {
    nameCell.append(h("span", { class: `bud-goal-m ${metrics.onTrack ? "ok" : "warn"}`, text: metrics.onTrack ? "✓" : `⚠️ ${fmt(metrics.monthlyNeeded)}/mo` }));
  }
  if (metrics?.type === "savings" && !metrics.complete) {
    nameCell.append(h("span", { class: "bud-goal-m sav", text: `${Math.round(metrics.progress)}%` }));
  }
  if (returned > 0.005) nameCell.append(h("span", { class: "bud-returned", text: `↩ ${fmt(returned)}` }));
  row.append(nameCell);

  const amtCell = h("div", { class: "bud-cell right", onclick: (e) => e.stopPropagation() });
  const built = amountInput({
    value: budgeted,
    allowNegative: true,
    disabled: ro || reorder,
    label: cat.name,
    onCommit: (val) => commitAssigned(ctx, cat, month, val),
  });
  const inp = built.matches?.("input.amount-input") ? built : (built.querySelector?.("input") || built);
  inp.classList.add("bud-amt");
  if (!budgeted) inp.classList.add("zero");
  amtCell.append(inp);
  row.append(amtCell);

  if (showAct) {
    const hasA = Math.abs(activity) > 0.005;
    const act = h(hasA ? "button" : "div", {
      class: `bud-cell right bud-act ${activityClass(activity)}`,
      type: hasA ? "button" : undefined,
      text: fmtActivity(activity),
      onclick: hasA ? (e) => { e.stopPropagation(); goMonthActivity(ctx, { categoryId: cat.id }); } : undefined,
    });
    row.append(act);
  }

  const isPos = avail > 0.005, isNeg = avail < -0.005;
  const av = h((isPos || isNeg) && !ro ? "button" : "div", {
    class: `bud-cell right bud-avail ${availableClass(avail)}`,
    type: (isPos || isNeg) && !ro ? "button" : undefined,
    text: fmt(avail),
    onclick: (isPos || isNeg) && !ro ? (e) => {
      e.stopPropagation();
      if (isPos) openMove(ctx, cat.id, null);
      else openMove(ctx, null, cat.id);
    } : undefined,
  });
  row.append(av);
  wrap.append(row);

  if (hintOn && !cat.creditCardId) {
    const ta = trailingAvg(budget, cat.id, month);
    if (ta) {
      const over = ta.avg > budgeted + 0.005;
      wrap.append(h("div", { class: "bud-hint" },
        h("span", { text: `📊 ${ta.monthsUsed}-mo avg spend:` }),
        h("span", { class: over ? "warn" : "ok", text: `${fmt(ta.avg)}/mo` }),
        h("span", { class: "muted", text: `· budgeted ${fmt(budgeted)}` }),
        over ? h("span", { class: "warn", text: `⚠️ under by ${fmt(ta.avg - budgeted)}` }) : null,
      ));
    }
  }

  if (reorder) bindDragHandle(wrap, "category", cat.id);
  else bindContextMenu(wrap, () => [
    { label: "⚙️ Category Settings", edit: true, onClick: () => openCategory(ctx, cat) },
    { label: cat.archived ? "↩ Restore Category" : "🗂 Archive Category", edit: true, onClick: () => ctx.updateBudget((b) => archiveCategory(b, cat.id, month)) },
    { label: "📝 Add Note for This Month", edit: true, onClick: () => openNote(ctx, cat) },
    { label: "📊 View Activity", onClick: () => goMonthActivity(ctx, { categoryId: cat.id }) },
  ], { readOnly: ro });
  return wrap;
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
  let tab = cat.creditCardId ? "note" : "goal";
  let name = cat.name;
  let nameError = "";
  let groupId = cat.groupId;
  let note = cat.note || "";
  const changes = cat.rolloverChanges || [];
  const applicable = changes.filter((c) => c.month <= month).sort((a, b) => b.month.localeCompare(a.month));
  let rollover = applicable[0]?.type || cat.rollover || "rollover";
  let rolloverMax = cat.rolloverMax || 0;
  let goalType = cat.goal?.type || "";
  let goalTarget = cat.goal?.target || 0;
  let goalDate = cat.goal?.targetDate || "";
  let deleteConfirm = false;
  const used = (budget.transactions || []).some((t) => t.categoryId === cat.id || t.splits?.some((s) => s.categoryId === cat.id));
  const tabs = cat.creditCardId ? [["note", "📝 Note"]] : [["goal", "🎯 Goal"], ["rollover", "🔄 Rollover"], ["note", "📝 Note"]];
  const sheet = openSheet({
    title: "Category Settings",
    closeLabel: "Discard",
    body: (host) => {
      const paint = () => {
        const nm = textInput({ value: name });
        nm.addEventListener("input", () => { name = nm.value; nameError = ""; });
        const group = h("select", { class: "input", disabled: !!cat.creditCardId });
        for (const g of budget.categoryGroups || []) {
          if (!cat.creditCardId && g.name === "Credit Card Payments") continue;
          if (cat.creditCardId && g.name !== "Credit Card Payments" && g.id !== cat.groupId) continue;
          group.append(h("option", { value: g.id, text: g.name }));
        }
        group.value = groupId;
        group.addEventListener("change", () => { groupId = group.value; });
        const tabBar = h("div", { class: "cat-tabs" });
        for (const [id, lbl] of tabs) {
          tabBar.append(h("button", {
            type: "button",
            class: tab === id ? "cat-tab on" : "cat-tab",
            text: lbl,
            onclick: () => { tab = id; paint(); },
          }));
        }
        const kids = [
          field("Category Name", nm),
          errLine(nameError),
          field("Group", group),
        ];
        if (cat.creditCardId) kids.push(h("div", { class: "form-muted", text: "Credit card payment categories can't be moved." }));
        kids.push(tabBar);
        if (cat.creditCardId && tab !== "note") {
          kids.push(h("div", { class: "soft-box", text: "Credit card payment categories automatically roll over their full balance each month and don't support goals. The available amount always reflects what you owe on the card." }));
        }
        if (tab === "goal" && !cat.creditCardId) {
          const list = h("div", { class: "opt-list" });
          for (const gt of GOAL_TYPES) {
            list.append(optCard({
              name: "goal-type", value: gt.value, checked: goalType === gt.value,
              title: gt.label, desc: gt.desc,
              onChange: (v) => { goalType = v; paint(); },
            }));
          }
          kids.push(field("Goal Type", list));
          if (goalType === "savings") kids.push(field("Savings Target ($)", amountInput({ value: goalTarget, onCommit: (n) => { goalTarget = n; }, placeholder: "e.g. 1000" })));
          if (goalType === "monthly") kids.push(field("Monthly Amount ($)", amountInput({ value: goalTarget, onCommit: (n) => { goalTarget = n; }, placeholder: "e.g. 500" })));
          if (goalType === "date") {
            kids.push(field("Total Target ($)", amountInput({ value: goalTarget, onCommit: (n) => { goalTarget = n; }, placeholder: "e.g. 3000" })));
            kids.push(field("Target Date", h("input", { class: "input", type: "month", value: goalDate, min: today, onchange: (e) => { goalDate = e.target.value; } })));
          }
        }
        if (tab === "rollover" && !cat.creditCardId) {
          if (goalType === "date") {
            kids.push(h("div", { class: "soft-box", text: "🏁 By-date goal categories automatically roll over up to your target amount each month, and return any excess to Ready to Assign. This can't be changed." }));
          } else {
            const filtered = goalType === "savings" ? ROLLOVER_OPTS.filter((o) => o.value !== "return") : ROLLOVER_OPTS;
            const effectiveMin = goalType === "savings" ? (goalTarget || 0) : 0;
            if (past) kids.push(h("div", { class: "warn-box", text: "🔒 Rollover changes apply from the current month forward. Viewing a past month — rollover shown is read-only." }));
            const label = `Rollover Behavior${(!past && month) ? ` (effective from ${monthLabel(month)})` : ""}`;
            const list = h("div", { class: "opt-list" });
            for (const opt of filtered) {
              list.append(optCard({
                name: "roll", value: opt.value, checked: rollover === opt.value, disabled: past,
                title: opt.title, desc: opt.desc,
                onChange: (v) => { rollover = v; paint(); },
              }));
            }
            kids.push(field(label, list));
            if (!past && rollover === "max") {
              kids.push(field(
                "Maximum rollover ($)" + (effectiveMin > 0 ? " — minimum " + fmt(effectiveMin) : ""),
                amountInput({
                  value: Math.max(rolloverMax, effectiveMin),
                  onCommit: (v) => { rolloverMax = Math.max(v, effectiveMin); },
                  placeholder: "e.g. 200",
                }),
              ));
              if (goalType === "savings" && rolloverMax < effectiveMin) {
                kids.push(h("div", { class: "gold-note", text: `Cap can't be less than your savings target (${fmt(effectiveMin)}). It will be set to ${fmt(effectiveMin)}.` }));
              }
            }
          }
        }
        if (tab === "note") {
          const parts = splitGoalNote(note);
          const ta = h("textarea", { class: "input note-area", rows: "6", placeholder: "Add a note about this category..." });
          ta.value = parts.editable;
          ta.addEventListener("input", () => { note = joinGoalNote(ta.value, parts.changes); });
          kids.push(field("Note", ta));
          if (parts.changes) {
            kids.push(h("div", { class: "goal-log" },
              h("div", { class: "goal-log-h", text: "Goal Changes (auto-recorded)" }),
              h("div", { class: "goal-log-b", text: parts.changes }),
            ));
          }
        }
        kids.push(btnRow(
          { label: "Cancel", kind: "ghost", onClick: () => sheet.close() },
          { label: "Save Changes", onClick: () => {
            const titled = toTitleCase(name.trim());
            if (!titled) { nameError = "Category name can't be empty."; paint(); return; }
            if (ctx.budget().categories.some((c) => c.id !== cat.id && c.name.toLowerCase() === titled.toLowerCase())) {
              nameError = `A category named "${name.trim()}" already exists.`;
              paint();
              return;
            }
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
          }},
        ));
        const foot = h("div", { class: "cat-foot" });
        foot.append(btn(cat.archived ? "↩ Restore Category" : "🗂 Archive Category", { kind: "ghost amber", onClick: () => { ctx.updateBudget((b) => archiveCategory(b, cat.id, month)); sheet.close(); } }));
        if (!cat.archived) foot.append(h("div", { class: "form-muted center", text: "Archiving moves this to \"Uncategorized\" and tags the name with today's date" }));
        if (deleteConfirm) {
          foot.append(h("div", { class: "danger-note", text: `Delete "${cat.name}"? Any money assigned to it (in any month) returns to Ready to Assign. This cannot be undone.` }));
          foot.append(h("div", { class: "row gap" },
            btn("Cancel", { kind: "ghost", onClick: () => { deleteConfirm = false; paint(); } }),
            btn("Confirm Delete", { kind: "danger", onClick: () => { ctx.updateBudget((b) => deleteCategory(b, cat.id)); sheet.close(); } }),
          ));
        } else {
          foot.append(btn("🗑 Delete Category", { kind: "ghost danger", disabled: used, onClick: () => { if (used) return; deleteConfirm = true; paint(); } }));
          if (used) foot.append(h("div", { class: "form-muted center", text: "Has transactions (incl. splits) — archive instead, or move its transactions to another category first" }));
        }
        kids.push(foot);
        host.replaceChildren(...kids.filter(Boolean));
      };
      paint();
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
  let nameError = "";
  let groupId = (budget.categoryGroups || []).find((g) => g.name !== "Credit Card Payments")?.id || budget.categoryGroups[0]?.id || "";
  let rollover = "rollover";
  let rolloverMax = 0;
  const sheet = openSheet({
    title: "New Category",
    closeLabel: "Discard",
    body: (host) => {
      const paint = () => {
        const nm = textInput({ placeholder: "e.g. Coffee", value: name });
        nm.addEventListener("input", () => { name = nm.value; nameError = ""; });
        const group = h("select", { class: "input" });
        for (const g of budget.categoryGroups || []) if (g.name !== "Credit Card Payments") group.append(h("option", { value: g.id, text: g.name }));
        group.value = groupId || "";
        group.addEventListener("change", () => { groupId = group.value; });
        const picker = h("div");
        for (const opt of ROLLOVER_OPTS) {
          picker.append(optCard({
            name: "new-roll", value: opt.value, checked: rollover === opt.value,
            title: opt.title, desc: opt.desc,
            onChange: (v) => { rollover = v; paint(); },
          }));
        }
        const kids = [
          h("div", { class: "two-col" }, field("Name", nm), field("Group", group)),
          errLine(nameError),
          field("Rollover Behavior", picker),
        ];
        if (rollover === "max") {
          kids.push(field("Maximum rollover ($)", amountInput({ value: rolloverMax, onCommit: (n) => { rolloverMax = n; }, placeholder: "e.g. 200" })));
        }
        kids.push(btnRow(
          { label: "Cancel", kind: "ghost", onClick: () => sheet.close() },
          { label: "Add Category", kind: "primary purple", disabled: !name.trim() || !groupId, onClick: () => {
            if (!name.trim() || !groupId) return;
            if ((ctx.budget().categories || []).some((c) => c.name.toLowerCase() === name.trim().toLowerCase())) {
              nameError = `A category named "${name.trim()}" already exists. Choose a different name.`;
              paint();
              return;
            }
            const res = addCategory(ctx.budget(), { name, groupId, rollover, rolloverMax: rollover === "max" ? rolloverMax : 0 });
            if (res.error) { nameError = res.error; paint(); return; }
            ctx.updateBudget(() => res.budget);
            sheet.close();
          }},
        ));
        host.replaceChildren(...kids.filter(Boolean));
        nm.focus();
      };
      paint();
    },
  });
}


export function openHistory(ctx) {
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
  let nameError = "";
  let deleteConfirm = false;
  const locked = group.name === "Credit Card Payments";
  const isUncategorized = group.name === "Uncategorized";
  const catCount = (budget.categories || []).filter((c) => c.groupId === group.id).length;
  const sheet = openSheet({
    title: "Edit Group",
    closeLabel: "Discard",
    body: (host) => {
      const paint = () => {
        const input = textInput({ value: name });
        input.disabled = locked;
        input.addEventListener("input", () => { name = input.value; nameError = ""; });
        const kids = [field("Group Name", input), errLine(nameError)];
        kids.push(btnRow(
          { label: "Cancel", kind: "ghost", onClick: () => sheet.close() },
          { label: "Save", disabled: locked || !name.trim(), onClick: () => {
            if (locked || !name.trim()) return;
            if ((ctx.budget().categoryGroups || []).some((g) => g.id !== group.id && g.name.toLowerCase() === name.trim().toLowerCase())) {
              nameError = `A group named "${name.trim()}" already exists. Choose a different name.`;
              paint();
              return;
            }
            ctx.updateBudget((b) => renameGroup(b, group.id, name));
            sheet.close();
          }},
        ));
        if (!isUncategorized && !locked) {
          const box = h("div", { class: "cat-foot" });
          if (deleteConfirm) {
            const extra = catCount > 0 ? ` Its ${catCount} categor${catCount !== 1 ? "ies" : "y"} will move to "Uncategorized".` : "";
            box.append(h("div", { class: "danger-note", text: `Delete "${group.name}"?${extra} This cannot be undone.` }));
            box.append(h("div", { class: "row gap" },
              btn("No, Cancel", { kind: "ghost", onClick: () => { deleteConfirm = false; paint(); } }),
              btn("Yes, Delete", { kind: "danger", onClick: () => { ctx.updateBudget((b) => deleteGroup(b, group.id)); sheet.close(); } }),
            ));
          } else {
            box.append(btn("Delete Group", { kind: "ghost danger", onClick: () => { deleteConfirm = true; paint(); } }));
          }
          kids.push(box);
        }
        host.replaceChildren(...kids.filter(Boolean));
        if (!locked) input.focus();
      };
      paint();
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
