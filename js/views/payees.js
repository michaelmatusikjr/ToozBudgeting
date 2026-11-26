import { h, btn, openSheet, field, textInput, toast, keepFocus } from "../ui.js?v=120";
import { toTitleCase } from "../util.js?v=120";
import { canonicalNames, displayName, originalsForCanonical, buildMergeGroups, getSharedWordsDefault, payeeDefaultCategory, payeeSuggestedCategory } from "../payees.js?v=120";
import { setCanonical, unmergeOriginal, unmergeAll, setPayeeCategory, rejectMerge, clearPayeeCategories } from "../mutate.js?v=120";

export function renderPayees(root, ctx) {
  const budget = ctx.budget();
  const q = (ctx.ui.payeeQuery || "").toLowerCase();
  const names = canonicalNames(budget).filter((n) => !q || n.toLowerCase().includes(q)).sort((a, b) => a.localeCompare(b));
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
  root.append(h("header", { class: "view-head" }, h("h1", { text: "Payees" }), btn("Merge", { kind: "ghost", onClick: () => openMerge(ctx, null) })));
  root.append(search);
  if (typing) { ctx.ui.payeeTyping = false; keepFocus(search); }
  if (groups.length) {
    root.append(h("button", { class: "notice", type: "button", onclick: () => openSuggestions(ctx, groups) },
      h("strong", { text: `${groups.length} merge suggestion${groups.length === 1 ? "" : "s"}` }),
      h("span", { text: "Similar names. Words in the exclude list are ignored." }),
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
  root.append(h("div", { class: "row gap wrap" },
    btn("Exclude words", { kind: "quiet", onClick: () => openExclude(ctx) }),
    btn("Clear defaults", { kind: "quiet", onClick: () => { ctx.updateBudget((b) => clearPayeeCategories(b)); toast("Payee categories cleared"); } }),
    btn("Unmerge all", { kind: "quiet", onClick: () => { ctx.updateBudget((b) => unmergeAll(b)); toast("All payees show their original names"); } }),
  ));
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
  const names = canonicalNames(budget).filter((n) => (budget.transactions || []).some((t) => displayName(budget, t.originalPayee || t.payee) === n && t.subtype !== "starting_balance"));
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
  const sheet = openSheet({
    title: "Suggestions",
    body: (host) => {
      for (const g of groups) {
        const shared = getSharedWordsDefault(g);
        host.append(h("div", { class: "pair" },
          h("strong", { text: g.join(" · ") }),
          h("p", { class: "hint", text: shared ? `Suggested name: ${shared}` : "" }),
          h("div", { class: "row gap" },
            btn("Merge", { onClick: () => { sheet.close(); openMerge(ctx, g); } }),
            btn("Not the same", { kind: "quiet", onClick: () => { ctx.updateBudget((b) => rejectMerge(b, g)); sheet.close(); toast("Won’t suggest that pair"); } }),
          ),
        ));
      }
    },
  });
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
