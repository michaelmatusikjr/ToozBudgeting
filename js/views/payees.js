import { h, btn, openSheet, field, textInput, toast, keepFocus } from "../ui.js?v=137";
import { toTitleCase } from "../util.js?v=137";
import { displayName, originalsForCanonical, buildMergeGroups, getSharedWordsDefault, payeeDefaultCategory, payeeSuggestedCategory, payeeDirectory, isAccountPayee } from "../payees.js?v=137";
import { setCanonical, unmergeOriginal, unmergeAll, setPayeeCategory, rejectMerge, clearPayeeCategories } from "../mutate.js?v=137";

export function renderPayees(root, ctx) {
  const budget = ctx.budget();
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
  const search = h("input", { class: "input", type: "search", placeholder: "Search payees", value: ctx.ui.payeeQuery || "", "aria-label": "Search payees" });
  const typing = ctx.ui.payeeTyping;
  search.addEventListener("input", () => { ctx.ui.payeeQuery = search.value; ctx.ui.payeeTyping = true; ctx.render(); });
  root.append(h("header", { class: "view-head" }, h("h1", { text: "Payees" })));
  root.append(h("div", { class: "search-row" }, search));
  root.append(h("nav", { class: "link-row", "aria-label": "Payee tools" },
    h("button", { class: "text-link", type: "button", text: "Merge", onclick: () => openMerge(ctx, null) }),
    h("button", { class: "text-link", type: "button", text: "Exclude words", onclick: () => openExclude(ctx) }),
    h("button", { class: "text-link", type: "button", text: "Clear defaults", onclick: () => { ctx.updateBudget((b) => clearPayeeCategories(b)); toast("Payee categories cleared"); } }),
    h("button", { class: "text-link", type: "button", text: "Unmerge all", onclick: () => { ctx.updateBudget((b) => unmergeAll(b)); toast("All payees show their original names"); } }),
  ));
  if (typing) { ctx.ui.payeeTyping = false; keepFocus(search); }
  if (groups.length) {
    root.append(h("button", { class: "notice", type: "button", onclick: () => openSuggestions(ctx, groups) },
      h("strong", { text: `${groups.length} merge suggestion${groups.length === 1 ? "" : "s"}` }),
      h("span", { class: "notice-go", text: "Review" }),
    ));
  }
  const list = h("div", { class: "tx-list" });
  for (const name of shown) {
    const def = payeeDefaultCategory(budget, name);
    const cat = budget.categories.find((c) => c.id === def)?.name || "No default";
    list.append(h("button", { class: "line", type: "button", onclick: () => openPayee(ctx, name) },
      h("span", {}, h("strong", { text: name }), h("span", { class: "muted", text: `${counts[name]} · ${cat}` })),
    ));
  }
  if (!shown.length) list.append(h("p", { class: "empty", text: "Payees appear as you add transactions." }));
  root.append(list);
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
        btn("See transactions", { kind: "ghost", block: true, onClick: () => { sheet.close(); ctx.ui.txQuery = name; ctx.go("transactions"); } }),
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
