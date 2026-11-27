import { h, btn, openSheet, field, textInput, toast, keepFocus, confirmDialog, btnRow, bindContextMenu, isTouchUi } from "../ui.js?v=154";
import { displayName, originalsForCanonical, buildMergeGroups, getSharedWordsDefault, payeeCategoryState, payeeDirectory, isAccountPayee } from "../payees.js?v=154";
import { setCanonical, unmergeOriginal, unmergeAll, setPayeeCategory, rejectMerge, clearPayeeCategories } from "../mutate.js?v=154";

export function renderPayees(root, ctx) {
  const budget = ctx.budget();
  const ro = !!ctx.readOnly();
  const q = (ctx.ui.payeeQuery || "").toLowerCase();
  const names = payeeDirectory(budget).filter((n) => !q || n.toLowerCase().includes(q)).sort((a, b) => a.localeCompare(b));
  const counts = {};
  for (const tx of budget.transactions || []) {
    if (tx.subtype === "starting_balance") continue;
    const n = displayName(budget, tx.originalPayee || tx.payee);
    if (!n) continue;
    counts[n] = (counts[n] || 0) + 1;
  }
  const shown = names.filter((n) => counts[n]);
  const groups = buildMergeGroups(shown, budget.rejectedMerges || [], budget.mergeExcludeWords || ["TST*"]);
  if (!ctx.ui.selectedPayees) ctx.ui.selectedPayees = new Set();
  const selected = ctx.ui.selectedPayees;

  const view = h("div", { class: "pay-view" });
  view.append(h("p", { class: "pay-intro", text: "Set a default or suggested category for a payee. Default auto-fills and confirms. Suggested auto-fills but shows as unconfirmed. Select two or more to merge duplicates." }));

  const search = h("input", { class: "input", type: "search", placeholder: "🔍 Search payees...", value: ctx.ui.payeeQuery || "", "aria-label": "Search payees" });
  const typing = ctx.ui.payeeTyping;
  search.addEventListener("input", () => { ctx.ui.payeeQuery = search.value; ctx.ui.payeeTyping = true; ctx.render(); });
  view.append(search);

  if (groups.length) {
    const n = groups.length;
    view.append(h("button", { class: "pay-merge-banner", type: "button", onclick: () => openSuggestions(ctx, groups) },
      h("span", { text: `🔀 ${n} suggested merge${n !== 1 ? "s" : ""} — tap to review` }),
    ));
  }

  if (!shown.length && !q) {
    view.append(h("div", { class: "pay-empty" }, h("div", { class: "pay-empty-ico", text: "👥" }), h("div", { text: "No payees yet" })));
  } else {
    const table = h("div", { class: "pay-table" });
    table.append(h("div", { class: "pay-head" },
      h("span"), h("span", { text: "Payee" }), h("span", { text: "Category" }), h("span", { class: "pay-count-h", text: "#" }),
    ));
    const visible = shown;
    if (!visible.length) table.append(h("div", { class: "pay-none", text: `No payees match "${ctx.ui.payeeQuery || ""}"` }));
    for (const name of visible) {
      table.append(payeeRow(ctx, name, counts[name] || 0, selected, ro));
    }
    view.append(table);
  }

  const actions = h("div", { class: "pay-actions" });
  const hasCats = (budget.payees || []).some((p) => p.defaultCategoryId || p.suggestedCategoryId);
  const hasMerged = (budget.payees || []).some((p) => p.canonicalName && p.canonicalName !== p.name);
  const hasRejected = (budget.rejectedMerges || []).length > 0;
  actions.append(btn("🗑 Remove All Category Settings", {
    kind: "ghost small",
    disabled: ro || !hasCats,
    onClick: () => confirmDialog({
      title: "Are you sure?",
      message: "Remove all default and suggested categories? Every payee's category setting will be cleared.",
      confirm: "Yes, Continue",
      danger: true,
      onConfirm: () => { ctx.updateBudget((b) => clearPayeeCategories(b)); toast("Payee categories cleared"); },
    }),
  }));
  view.append(actions);

  view.append(h("div", { class: "pay-panel" },
    btn("↩ Unmerge All Payees", {
      kind: "danger",
      disabled: ro || !hasMerged,
      onClick: () => confirmDialog({
        title: "Are you sure?",
        message: "Unmerge all payees? Every merged display name will be removed and each payee will revert to showing its original name from your transactions.",
        confirm: "Yes, Continue",
        danger: true,
        onConfirm: () => { ctx.updateBudget((b) => unmergeAll(b)); toast("All payees show their original names"); },
      }),
    }),
    h("p", { class: "pay-panel-note", text: "Removes all merged display names. Each payee will go back to showing its original name exactly as it appeared in your transactions. Your transactions are not affected." }),
  ));

  view.append(h("div", { class: "pay-panel" },
    btn("🔄 Reset Merge Suggestions", {
      kind: "ghost",
      disabled: ro || !hasRejected,
      onClick: () => confirmDialog({
        title: "Are you sure?",
        message: "Reset all rejected merge suggestions? Payees you previously chose not to merge will be suggested again.",
        confirm: "Yes, Continue",
        onConfirm: () => { ctx.updateBudget((b) => ({ ...b, rejectedMerges: [] })); toast("Merge suggestions reset"); },
      }),
    }),
    h("p", { class: "pay-panel-note", text: 'Clears your "do not merge" decisions. Any payees you previously rejected as merge suggestions will be offered again the next time you review.' }),
  ));

  const words = budget.mergeExcludeWords || ["TST*"];
  const exclude = h("div", { class: "pay-exclude" });
  exclude.append(h("div", { class: "pay-exclude-head" },
    h("div", {},
      h("div", { class: "pay-exclude-title", text: "Merge Exclusion Words" }),
      h("div", { class: "pay-exclude-sub", text: "Words that won't trigger merge suggestions. Other words in the same payee still count." }),
    ),
    ro ? null : btn("+ Add", { kind: "purple small", onClick: () => openAddExclude(ctx) }),
  ));
  if (words.length) {
    const chips = h("div", { class: "pay-chips" });
    for (const word of words) {
      const chip = h("span", { class: "pay-chip", text: word });
      if (!ro) {
        chip.append(h("button", { type: "button", class: "pay-chip-x", text: "×", "aria-label": `Remove ${word}`, onclick: () => {
          ctx.updateBudget((b) => ({ ...b, mergeExcludeWords: (b.mergeExcludeWords || []).filter((w) => w !== word) }));
        }}));
      }
      chips.append(chip);
    }
    exclude.append(chips);
  } else {
    exclude.append(h("div", { class: "pay-exclude-empty", text: "No exclusion words set." }));
  }
  if (words.length && !ro) {
    exclude.append(btn("🗑 Clear All Exclusion Words", {
      kind: "danger small",
      onClick: () => confirmDialog({
        title: "Are you sure?",
        message: "Clear all merge exclusion words? All words including the default \"TST*\" will be removed.",
        confirm: "Yes, Continue",
        danger: true,
        onConfirm: () => { ctx.updateBudget((b) => ({ ...b, mergeExcludeWords: [] })); },
      }),
    }));
  }
  view.append(exclude);

  if (selected.size >= 2 && !ro) {
    view.append(btn(`Merge ${selected.size} Payees`, { kind: "purple", onClick: () => openMerge(ctx, [...selected]) }));
  }

  root.append(view);
  if (typing) { ctx.ui.payeeTyping = false; keepFocus(search); }
}

function firstUsableCategory(budget) {
  return (budget.categories || []).find((c) => !c.archived && !c.creditCardId)?.id || "";
}

function setPayeeMode(ctx, name, mode, activeCatId) {
  const fallback = activeCatId || firstUsableCategory(ctx.budget());
  ctx.updateBudget((b) => {
    if (mode === "none") {
      let n = setPayeeCategory(b, name, "", "default");
      return setPayeeCategory(n, name, "", "suggested");
    }
    if (mode === "default") return setPayeeCategory(b, name, fallback, "default");
    return setPayeeCategory(b, name, fallback, "suggested");
  });
}

function payeeRow(ctx, name, count, selected, ro) {
  const budget = ctx.budget();
  const originals = originalsForCanonical(budget, name);
  const isMerged = originals.some((o) => o !== name);
  const { mode, catId } = payeeCategoryState(budget, name);
  const row = h("div", { class: "pay-row" });
  const box = h("input", { type: "checkbox", checked: selected.has(name), disabled: !!ro });
  box.addEventListener("change", (e) => {
    e.stopPropagation();
    if (box.checked) selected.add(name);
    else selected.delete(name);
    ctx.render();
  });
  const nameEl = h("button", { type: "button", class: "pay-name", text: name });
  if (isMerged) nameEl.append(h("span", { class: "pay-merged", text: `(${originals.length})` }));
  nameEl.addEventListener("click", (e) => { e.stopPropagation(); openDisplayName(ctx, name); });
  const modes = h("div", { class: "pay-modes" });
  for (const m of ["none", "default", "suggested"]) {
    const on = mode === m;
    modes.append(h("button", {
      type: "button",
      class: `pay-mode${on ? ` on ${m}` : ""}`,
      disabled: !!ro,
      text: m === "none" ? "—" : m,
      onclick: () => { if (!ro && !on) setPayeeMode(ctx, name, m, catId); },
    }));
  }
  const catCell = h("div", { class: "pay-cat" }, modes);
  if (mode !== "none") {
    const sel = h("select", { class: "input pay-cat-sel", disabled: !!ro });
    sel.append(h("option", { value: "", text: "—" }));
    for (const g of budget.categoryGroups || []) {
      const og = h("optgroup", { label: g.name });
      for (const c of (budget.categories || []).filter((c) => c.groupId === g.id && !c.archived)) {
        og.append(h("option", { value: c.id, text: c.name }));
      }
      sel.append(og);
    }
    sel.value = catId;
    sel.addEventListener("change", () => {
      if (ro) return;
      ctx.updateBudget((b) => setPayeeCategory(b, name, sel.value, mode === "default" ? "default" : "suggested"));
    });
    catCell.append(sel);
  }
  const num = h("button", { type: "button", class: "pay-count", text: String(count), onclick: () => ctx.go("transactions", { payee: name }) });
  row.append(box, nameEl, catCell, num);
  bindContextMenu(row, () => {
    const originalsNow = originalsForCanonical(ctx.budget(), name);
    const merged = originalsNow.some((o) => o !== name);
    return [
      { label: "✏️ Set Display Name", edit: true, onClick: () => openDisplayName(ctx, name) },
      {
        label: merged ? `↩ Unmerge All (${originalsNow.length})` : "↩ Unmerge",
        disabled: !merged,
        edit: true,
        onClick: () => askSure(`Unmerge all original payee names from "${name}"? Each original name will revert to displaying itself.`, () => {
          ctx.updateBudget((b) => unmergeCanonical(b, originalsNow));
        }),
      },
    ];
  }, { readOnly: ro });
  return row;
}

function openAddExclude(ctx) {
  const input = textInput({ placeholder: "e.g. TST*" });
  const sheet = openSheet({
    title: "Add Exclusion Word",
    closeLabel: "Discard",
    body: (host) => {
      const save = () => {
        const word = input.value.trim();
        if (!word) return;
        ctx.updateBudget((b) => {
          const words = [...(b.mergeExcludeWords || [])];
          if (!words.some((w) => w.toLowerCase() === word.toLowerCase())) words.push(word);
          return { ...b, mergeExcludeWords: words };
        });
        sheet.close();
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
      host.append(field("Word", input), btnRow({ label: "Cancel", kind: "ghost", onClick: () => sheet.close() }, { label: "Add", kind: "purple", onClick: save }));
      input.focus();
    },
  });
}

function askSure(message, onConfirm) {
  const sheet = openSheet({
    title: "Are you sure?",
    body: (host) => {
      host.append(
        h("p", { class: "pay-dn-lede", text: message }),
        btnRow(
          { label: "No, Cancel", kind: "ghost", onClick: () => sheet.close() },
          { label: "Yes, Continue", kind: "danger", onClick: () => { sheet.close(); onConfirm?.(); } },
        ),
      );
    },
  });
}

function unmergeCanonical(budget, originals) {
  let next = budget;
  for (const o of originals || []) next = unmergeOriginal(next, o);
  return next;
}

function txCount(budget, name) {
  return (budget.transactions || []).reduce((n, t) => n + (t.subtype !== "starting_balance" && displayName(budget, t.originalPayee || t.payee) === name ? 1 : 0), 0);
}

function openDisplayName(ctx, name) {
  const ro = !!ctx.readOnly();
  const budget = ctx.budget();
  const originals = originalsForCanonical(budget, name);
  const input = textInput({ placeholder: `Current: ${name}` });
  if (ro) input.disabled = true;
  const err = h("div", { class: "pay-dn-err" });
  const sheet = openSheet({
    title: "Payee Display Name",
    closeLabel: "Discard",
    body: (host) => {
      host.append(h("p", { class: "pay-dn-lede", text: `All transactions whose original payee name maps to "${name}" will show the selected name.` }));
      const list = h("div", { class: "pay-dn-list" });
      list.append(h("div", { class: "pay-dn-head", text: "Original names in this group" }));
      for (const o of originals) {
        const row = h("div", { class: "pay-dn-item" }, h("span", { text: o }));
        if (!ro && o !== name) {
          row.append(btn("↩ Unmerge", { kind: "ghost small", onClick: () => {
            sheet.close();
            askSure(`Unmerge "${o}"? Transactions with this original payee will revert to displaying "${o}" instead of "${name}".`, () => {
              ctx.updateBudget((b) => unmergeOriginal(b, o));
            });
          }}));
        }
        list.append(row);
      }
      host.append(list);
      if (!ro && originals.length > 1) {
        const all = btn(`↩ Unmerge All (${originals.length})`, { kind: "danger small", onClick: () => {
          sheet.close();
          askSure(`Unmerge all ${originals.length} original payee names from "${name}"? Each will revert to displaying its own original name.`, () => {
            ctx.updateBudget((b) => unmergeCanonical(b, originals));
          });
        }});
        all.classList.add("pay-dn-all");
        host.append(all);
      }
      const saveBtn = btn("Close", { kind: "purple", onClick: () => {
        const custom = input.value.trim();
        if (!custom || custom === name || ro) { sheet.close(); return; }
        ctx.updateBudget((b) => setCanonical(b, originalsForCanonical(b, name), custom));
        sheet.close();
      }});
      input.addEventListener("input", () => {
        const span = saveBtn.querySelector("span");
        if (span) span.textContent = input.value.trim() ? "Apply" : "Close";
        err.textContent = "";
      });
      host.append(
        field("Set custom display name for all above", input),
        err,
        btnRow({ label: "Cancel", kind: "ghost", onClick: () => sheet.close() }, saveBtn),
      );
    },
  });
}

function openMerge(ctx, preset) {
  const names = [...(preset || [])];
  let canonical = names[0] || "";
  const input = textInput({ placeholder: "Type a new payee name..." });
  const collide = h("div", { class: "pay-merge-collide" });
  const opts = [];
  const sheet = openSheet({
    title: "Merge Payees",
    closeLabel: "Discard",
    body: (host) => {
      host.append(h("p", { class: "pay-merge-lede", text: "Choose which display name to keep, or enter your own. All original payee names in these groups will map to this display name." }));
      for (const n of names) {
        const lab = h("label", { class: "pay-merge-opt" });
        const radio = h("input", { type: "radio", name: "pay-merge-canon" });
        radio.addEventListener("change", () => { canonical = n; input.value = ""; sync(); });
        lab.append(radio, h("span", { text: n }));
        host.append(lab);
        opts.push({ n, lab, radio });
      }
      const save = btn("Merge", { kind: "purple", onClick: () => {
        const finalCanonical = (input.value.trim() || canonical).trim();
        if (!finalCanonical) return;
        const originals = names.flatMap((n) => originalsForCanonical(ctx.budget(), n));
        ctx.updateBudget((b) => setCanonical(b, [...new Set(originals)], finalCanonical));
        ctx.ui.selectedPayees = new Set();
        sheet.close();
      }});
      const sync = () => {
        const custom = input.value.trim();
        const finalCanonical = custom || canonical;
        for (const o of opts) {
          const on = !custom && canonical === o.n;
          o.radio.checked = on;
          o.lab.classList.toggle("on", on);
        }
        const dir = payeeDirectory(ctx.budget());
        const hit = custom && dir.find((n) => n.toLowerCase() === custom.toLowerCase() && !names.includes(n));
        collide.textContent = hit ? `"${hit}" is already a payee — it'll be merged into "${finalCanonical}" too.` : "";
        save.disabled = !finalCanonical;
      };
      input.addEventListener("input", sync);
      host.append(field("Or enter a custom display name", input), collide, btnRow(
        { label: "Cancel", kind: "ghost", onClick: () => sheet.close() },
        save,
      ));
      sync();
    },
  });
}

function toModalGroups(rawGroups) {
  return rawGroups.map((g) => ({
    names: [...g],
    checked: [...g],
    customName: getSharedWordsDefault(g),
  }));
}

function currentSuggestionGroups(ctx) {
  const budget = ctx.budget();
  const shown = payeeDirectory(budget).filter((n) => txCount(budget, n));
  return buildMergeGroups(shown, budget.rejectedMerges || [], budget.mergeExcludeWords || ["TST*"])
    .map((names) => names.filter((n) => !isAccountPayee(budget, n)))
    .filter((names) => names.length > 1);
}

function openSuggestions(ctx, groups) {
  const start = toModalGroups((groups || currentSuggestionGroups(ctx)).map((names) => names.filter((n) => !isAccountPayee(ctx.budget(), n))).filter((names) => names.length > 1));
  if (!start.length) return;
  let state = { groups: start, currentIdx: 0 };
  let sheet;
  const setTitle = () => {
    const title = sheet?.content?.parentElement?.querySelector(".sheet-title");
    if (title) title.textContent = `🔀 Suggested Merge (${state.currentIdx + 1} of ${state.groups.length})`;
  };
  const goNext = (updatedGroups) => {
    const g = updatedGroups || state.groups;
    state = { groups: g, currentIdx: state.currentIdx + 1 };
    if (state.currentIdx >= state.groups.length) {
      sheet?.close();
      const leftover = currentSuggestionGroups(ctx);
      if (leftover.length) queueMicrotask(() => openSuggestions(ctx, leftover));
      return;
    }
    paint();
  };
  const applyMerge = () => {
    const grp = state.groups[state.currentIdx];
    const checkedNames = grp.checked;
    if (checkedNames.length < 2) { goNext(); return; }
    const target = grp.customName.trim() ? grp.customName.trim() : checkedNames[0];
    if (!target) { goNext(); return; }
    const allOriginals = checkedNames.flatMap((cn) => originalsForCanonical(ctx.budget(), cn));
    const uncheckedNames = grp.names.filter((n) => !checkedNames.includes(n));
    ctx.updateBudget((b) => {
      let next = setCanonical(b, [...new Set(allOriginals)], target);
      for (const un of uncheckedNames) next = rejectMerge(next, [un, target]);
      return next;
    });
    const budget = ctx.budget();
    const shown = payeeDirectory(budget).filter((n) => txCount(budget, n));
    const freshGroups = buildMergeGroups(shown, budget.rejectedMerges || [], budget.mergeExcludeWords || ["TST*"])
      .map((names) => names.filter((n) => !isAccountPayee(budget, n)))
      .filter((names) => names.length > 1);
    const upcomingKeys = new Set(state.groups.slice(state.currentIdx + 1).map((g) => [...g.names].sort().join("|||")));
    const newSuggestions = toModalGroups(freshGroups.filter((fg) => !upcomingKeys.has([...fg].sort().join("|||"))));
    const updatedGroups = [
      ...state.groups.slice(0, state.currentIdx + 1),
      ...newSuggestions,
      ...state.groups.slice(state.currentIdx + 1),
    ];
    goNext(updatedGroups);
  };
  const rejectGroup = () => {
    const names = state.groups[state.currentIdx].names;
    ctx.updateBudget((b) => rejectMerge(b, names));
    goNext();
  };
  const paint = () => {
    const host = sheet.content;
    host.replaceChildren();
    const grp = state.groups[state.currentIdx];
    if (!grp) { goNext(); return; }
    setTitle();
    const checkedNames = grp.checked;
    const budget = ctx.budget();
    const ro = !!ctx.readOnly();
    host.append(h("p", { class: "pay-suggest-lede", text: "These payees look like they might be the same. Check the ones to merge and pick a display name." }));
    const list = h("div", { class: "pay-suggest-list" });
    for (const n of grp.names) {
      const on = checkedNames.includes(n);
      const lab = h("label", { class: `pay-suggest-item${on ? " on" : ""}` });
      const box = h("input", { type: "checkbox", checked: on, disabled: ro });
      box.addEventListener("change", () => {
        grp.checked = on ? checkedNames.filter((x) => x !== n) : [...checkedNames, n];
        paint();
      });
      const count = txCount(budget, n);
      lab.append(
        box,
        h("div", { class: "pay-suggest-meta" },
          h("div", { class: "pay-suggest-name", text: n }),
          h("div", { class: "pay-suggest-count", text: `${count} transaction${count !== 1 ? "s" : ""}` }),
        ),
      );
      list.append(lab);
    }
    host.append(list);
    const touch = isTouchUi();
    const input = textInput({ value: grp.customName, placeholder: checkedNames[0] || "Display name..." });
    if (touch) input.readOnly = true;
    input.addEventListener("input", () => { grp.customName = input.value; });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && grp.checked.length >= 2 && !ro) applyMerge(); });
    input.addEventListener("focus", () => { if (touch) input.readOnly = false; });
    input.addEventListener("blur", () => { if (touch) input.readOnly = true; });
    input.addEventListener("click", () => {
      if (touch && input.readOnly) {
        input.readOnly = false;
        setTimeout(() => input.focus(), 0);
      }
    });
    host.append(field("Merge display name (leave blank to use first checked)", input));
    const mergeLabel = `✓ Merge ${checkedNames.length} payees${state.currentIdx + 1 < state.groups.length ? ` → Next (${state.groups.length - state.currentIdx - 1} left)` : ""}`;
    const mergeBtn = btn(mergeLabel, { kind: "purple", disabled: ro || checkedNames.length < 2, onClick: applyMerge });
    mergeBtn.addEventListener("mousedown", (e) => e.preventDefault());
    const rejectBtn = btn("Do not merge any of these payees", { kind: "ghost", disabled: ro, onClick: rejectGroup });
    rejectBtn.addEventListener("mousedown", (e) => e.preventDefault());
    host.append(h("div", { class: "pay-suggest-actions" }, mergeBtn, rejectBtn));
  };
  sheet = openSheet({
    title: `🔀 Suggested Merge (1 of ${start.length})`,
    body: () => {},
    onClose: () => { /* closing skips the rest, like the JSX */ },
  });
  paint();
}

function openExclude(ctx) {
  const budget = ctx.budget();
  const ta = h("textarea", { class: "input", rows: "4" });
  ta.value = (budget.mergeExcludeWords || []).join("\n");
  const sheet = openSheet({
    title: "Exclude words",
    body: (host) => {
      host.append(h("p", { class: "lede", text: "These words can’t start a merge suggestion. TST* is ignored as the token “tst*”, not as a wildcard." }),
        field("One word per line", ta),
        btn("Save", { block: true, onClick: () => {
          const words = ta.value.split(/\n+/).map((s) => s.trim()).filter(Boolean);
          ctx.updateBudget((b) => ({ ...b, mergeExcludeWords: words.length ? words : ["TST*"] }));
          sheet.close();
        }}));
    },
  });
}
