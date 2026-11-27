import { h, btn, openSheet, field, textInput, toast, keepFocus, confirmDialog, btnRow } from "../ui.js?v=154";
import { toTitleCase } from "../util.js?v=154";
import { displayName, originalsForCanonical, buildMergeGroups, getSharedWordsDefault, payeeDefaultCategory, payeeSuggestedCategory, payeeCategoryState, payeeDirectory, isAccountPayee } from "../payees.js?v=154";
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

function openPayee(ctx, name) {
  const budget = ctx.budget();
  const originals = originalsForCanonical(budget, name);
  const sheet = openSheet({
    title: name,
    body: (host) => {
      host.append(h("p", { class: "hint", text: originals.length > 1 ? `Merged from ${originals.join(", ")}` : "Not merged." }));
      const def = h("select", { class: "input" }, h("option", { value: "", text: "No default" }));
      const sug = h("select", { class: "input" }, h("option", { value: "", text: "No suggestion" }));
      for (const g of budget.categoryGroups) {
        const o1 = h("optgroup", { label: g.name });
        const o2 = h("optgroup", { label: g.name });
        for (const c of budget.categories.filter((c) => c.groupId === g.id && !c.archived && !c.creditCardId)) {
          o1.append(h("option", { value: c.id, text: c.name }));
          o2.append(h("option", { value: c.id, text: c.name }));
        }
        def.append(o1); sug.append(o2);
      }
      def.value = payeeDefaultCategory(budget, name) || "";
      sug.value = payeeSuggestedCategory(budget, name) || "";
      host.append(field("Default category", def), field("Suggested category", sug),
        btn("Save categories", { block: true, onClick: () => {
          ctx.updateBudget((b) => {
            let n = setPayeeCategory(b, name, def.value, "default");
            if (sug.value) n = setPayeeCategory(n, name, sug.value, "suggested");
            return n;
          });
          sheet.close();
        }}),
        btn("See transactions", { kind: "ghost", block: true, onClick: () => { sheet.close(); ctx.go("transactions", { payee: name }); } }),
      );
      if (originals.length) {
        host.append(h("p", { class: "kicker", text: "Original names" }));
        for (const o of originals) {
          host.append(h("div", { class: "line" }, h("span", { text: o }), btn("Unmerge", { kind: "quiet", onClick: () => { ctx.updateBudget((b) => unmergeOriginal(b, o)); sheet.close(); } })));
        }
      }
    },
  });
}

function openMerge(ctx, preset) {
  const budget = ctx.budget();
  const names = payeeDirectory(budget).filter((n) => (budget.transactions || []).some((t) => displayName(budget, t.originalPayee || t.payee) === n && t.subtype !== "starting_balance") && !isAccountPayee(budget, n));
  const picked = new Set(preset || []);
  const sheet = openSheet({
    title: "Merge payees",
    body: (host) => {
      const list = h("div", { class: "tx-list" });
      for (const n of names.sort((a, b) => a.localeCompare(b))) {
        list.append(h("label", { class: "line" },
          h("input", { type: "checkbox", checked: picked.has(n), onchange: (e) => { if (e.target.checked) picked.add(n); else picked.delete(n); } }),
          h("span", { text: n }),
        ));
      }
      const canon = textInput({ value: preset ? getSharedWordsDefault(preset) : "", placeholder: "Canonical name" });
      host.append(h("p", { class: "lede", text: "Transactions keep their original payee. The name you choose is what you’ll see." }), list, field("Display as", canon),
        btn("Merge", { block: true, onClick: () => {
          const chosen = [...picked];
          if (chosen.length < 2) { toast("Pick at least two payees"); return; }
          const display = toTitleCase((canon.value || chosen[0]).trim());
          const originals = chosen.flatMap((n) => originalsForCanonical(budget, n));
          ctx.updateBudget((b) => setCanonical(b, [...new Set(originals.length ? originals : chosen)], display));
          sheet.close();
          toast("Merged");
        }}));
    },
  });
}

function openSuggestions(ctx, groups) {
  let left = groups.map((names) => names.filter((n) => !isAccountPayee(ctx.budget(), n))).filter((names) => names.length > 1);
  let draft = null;
  let sheet;
  const countOf = (budget, name) => (budget.transactions || []).reduce((n, t) => n + (t.subtype !== "starting_balance" && displayName(budget, t.originalPayee || t.payee) === name ? 1 : 0), 0);
  const fresh = () => {
    const budget = ctx.budget();
    const shown = payeeDirectory(budget).filter((n) => countOf(budget, n));
    return buildMergeGroups(shown, budget.rejectedMerges || [], budget.mergeExcludeWords || ["TST*"])
      .map((names) => names.filter((n) => !isAccountPayee(budget, n)))
      .filter((names) => names.length > 1);
  };
  const paint = (host) => {
    host.replaceChildren();
    if (!left.length) {
      sheet?.close();
      toast("Suggestions finished");
      return;
    }
    const names = left[0];
    const key = names.join("|||");
    if (!draft || draft.key !== key) draft = { key, names, checked: new Set(names), custom: getSharedWordsDefault(names) };
    const title = host.parentElement?.querySelector(".sheet-title");
    if (title) title.textContent = left.length === 1 ? "Last suggestion" : `Suggestions · ${left.length} left`;
    const budget = ctx.budget();
    host.append(h("p", { class: "lede", text: "Check the ones that are the same payee. This stays open until you finish the list or close it." }));
    for (const name of names) {
      host.append(h("label", { class: "line" },
        h("input", {
          type: "checkbox",
          checked: draft.checked.has(name),
          onchange: (e) => {
            if (e.target.checked) draft.checked.add(name);
            else draft.checked.delete(name);
            paint(host);
          },
        }),
        h("span", {}, h("strong", { text: name }), h("span", { class: "muted", text: ` · ${countOf(budget, name)}` })),
      ));
    }
    const canon = textInput({ value: draft.custom, placeholder: [...draft.checked][0] || "Display name" });
    canon.addEventListener("input", () => { draft.custom = canon.value; });
    host.append(
      field("Display as", canon),
      btn("Merge", {
        block: true,
        disabled: draft.checked.size < 2,
        onClick: () => {
          if (draft.checked.size < 2) { toast("Check at least two payees"); return; }
          const chosen = [...draft.checked].filter((n) => !isAccountPayee(ctx.budget(), n));
          if (chosen.length < 2) { toast("Accounts can’t be merged with payees"); return; }
          const target = toTitleCase((draft.custom || chosen[0]).trim());
          if (!target || isAccountPayee(ctx.budget(), target)) { toast("Pick a payee name, not an account"); return; }
          const originals = chosen.flatMap((n) => originalsForCanonical(ctx.budget(), n));
          const unchecked = names.filter((n) => !draft.checked.has(n));
          ctx.updateBudget((b) => {
            let next = setCanonical(b, [...new Set(originals.length ? originals : chosen)], target);
            for (const un of unchecked) next = rejectMerge(next, [un, target]);
            return next;
          });
          draft = null;
          left = fresh();
          paint(host);
        },
      }),
      btn("Not the same", { kind: "quiet", block: true, onClick: () => {
        ctx.updateBudget((b) => rejectMerge(b, names));
        draft = null;
        left = fresh();
        paint(host);
      }}),
    );
  };
  sheet = openSheet({ title: "Suggestions", body: paint });
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
