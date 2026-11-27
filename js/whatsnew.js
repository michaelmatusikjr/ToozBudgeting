/** What's new: toast on a real version change, then a carousel of short animated recreations. */
import { h, openSheet, btn, icon, toast } from "./ui.js?v=153";
import { APP_VERSION } from "./util.js?v=153";
import { deviceGet, deviceSet } from "./store.js?v=153";

const RELEASES = [
  {
    version: "1.2.0",
    slides: [
      {
        demo: "colors",
        title: "In is green. Out is red.",
        body: "Income, refunds, and a card payment show as money in. Spending shows as money out, on the plan and in Activity.",
      },
      {
        demo: "pad",
        title: "Assign from the pad.",
        body: "Tap a budgeted amount and type. The first digit replaces what was there, and the pad stays above the keyboard.",
      },
      {
        demo: "reconcile",
        title: "Reconcile to the statement.",
        body: "Uncheck what hasn’t cleared. The difference follows the real balance, and Finish turns on when it matches.",
      },
      {
        demo: "activity",
        title: "Search stays put.",
        body: "Name and amount sit together. Date and category sit underneath. Search keeps your place while the list narrows.",
      },
      {
        demo: "plan",
        title: "Cover only when it’s needed.",
        body: "The month stays on one line. Cover shows up when a category is overspent, and it leaves when the month is whole.",
      },
      {
        demo: "inbox",
        title: "Notices, groups, and goals.",
        body: "The bell opens what needs you. Groups can be renamed and reordered. Goals sets every target in one place.",
      },
    ],
  },
  {
    version: "1.3.0",
    slides: [
      {
        demo: "zoom",
        title: "Fast taps stay put.",
        body: "A quick double tap no longer zooms the page. Pinch with two fingers when you actually want a closer look.",
      },
      {
        demo: "ledger",
        title: "The plan is a ledger.",
        body: "Each category is a name and what’s left. Assigned and activity sit under it as words, not buttons. Ready to Assign is type, not a card.",
      },
      {
        demo: "lists",
        title: "One list, not a stack of cards.",
        body: "Activity, accounts, payees, and settings share one surface. The filled button on a screen is the thing you came to do.",
      },
    ],
  },
  {
    version: "1.3.1",
    slides: [
      {
        demo: "activity",
        title: "A full budget can open.",
        body: "Thousands of transactions no longer freeze the plan. Activity shows the latest ones first, and you can show more.",
      },
    ],
  },
  {
    version: "1.3.2",
    slides: [
      {
        demo: "plan",
        title: "Cover overspending properly.",
        body: "Pick the categories the money comes from. The gap shrinks as you add them. A negative available amount moves money in, instead of opening cover.",
      },
    ],
  },
  {
    version: "1.3.3",
    slides: [
      {
        demo: "lists",
        title: "Closing an account pulls the money first.",
        body: "A leftover balance comes out of Ready to Assign and unspent categories, or you transfer what is left. A new category can roll over, return, or cap. Goal changes are written on the category note.",
      },
    ],
  },
  {
    version: "1.4.0",
    slides: [
      {
        demo: "colors",
        title: "A theme, and a place for your eye.",
        body: "Paper, Ink, and Dusk are built in. Custom is the background, the cards, the text, and one accent. Section titles sit on a band. Actions are buttons.",
      },
    ],
  },
  {
    version: "1.4.1",
    slides: [
      {
        demo: "lists",
        title: "Payees are not accounts.",
        body: "Account and card names stay off the payee list, and they are never offered as a merge. Suggestions stay open until you finish them or close the sheet.",
      },
    ],
  },
  {
    version: "1.4.2",
    slides: [
      {
        demo: "plan",
        title: "A short goal stays on the row.",
        body: "Underfunded goals are marked on the plan. They no longer raise a notice. The header no longer zooms or selects text.",
      },
    ],
  },
  {
    version: "1.5.0",
    slides: [
      {
        demo: "lists",
        title: "One budget for the household.",
        body: "Sign in with Google in Settings. Everyone you invite sees the same budget on every phone and computer, and changes show up for each other within a minute.",
      },
      {
        demo: "inbox",
        title: "Banks for everyone.",
        body: "Bank transactions come in once for the whole household. Owners connect banks and invite people. View-only people can look but not change anything.",
      },
    ],
  },
];

function versionCmp(a, b) {
  const pa = String(a || "0").split(".").map((n) => Number(n) || 0);
  const pb = String(b || "0").split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function taggedSlides() {
  return RELEASES.flatMap((r) => r.slides.map((s) => ({ ...s, version: r.version })));
}

export function slidesAfter(seen) {
  if (!seen) return taggedSlides();
  return taggedSlides().filter((s) => versionCmp(s.version, seen) > 0);
}

function play(steps, restartAt) {
  let dead = false;
  let timers = [];
  const run = () => {
    if (dead) return;
    let acc = 0;
    for (const step of steps) {
      acc += step.t;
      timers.push(setTimeout(() => { if (!dead) step.run(); }, acc));
    }
    timers.push(setTimeout(() => { timers = []; run(); }, restartAt));
  };
  run();
  return () => { dead = true; timers.forEach(clearTimeout); };
}

function stageBar() {
  const bar = h("span", { class: "wn-progress" });
  return bar;
}

const demos = {
  colors(host) {
    const rows = [
      ["Paycheck", "$1,200.00", "in"],
      ["Kroger", "−$42.18", "out"],
      ["Visa payment", "$200.00", "in"],
    ].map(([name, amt, kind]) => {
      const el = h("span", { class: `wn-amt ${kind}`, text: amt });
      return { el, row: h("div", { class: "wn-row" }, h("span", { text: name }), el) };
    });
    host.append(stageBar(), h("div", { class: "wn-stack" }, ...rows.map((r) => r.row)));
    return play([
      { t: 0, run: () => rows.forEach((r) => r.el.classList.remove("on")) },
      { t: 450, run: () => rows[0].el.classList.add("on") },
      { t: 650, run: () => rows[1].el.classList.add("on") },
      { t: 650, run: () => rows[2].el.classList.add("on") },
    ], 3600);
  },
  pad(host) {
    const display = h("div", { class: "wn-pad-num", text: "$80.00" });
    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((k) => h("span", { class: "wn-key", text: k }));
    const kb = h("div", { class: "wn-kb", text: "Keyboard" });
    const pad = h("div", { class: "wn-pad" }, display, h("div", { class: "wn-keys" }, ...keys));
    host.append(stageBar(), pad, kb);
    const press = (n) => keys.forEach((k) => k.classList.toggle("on", k.textContent === n));
    return play([
      { t: 0, run: () => { display.textContent = "$80.00"; press(""); pad.classList.remove("lift"); kb.classList.remove("on"); } },
      { t: 700, run: () => { press("2"); display.textContent = "$2"; } },
      { t: 550, run: () => { press("5"); display.textContent = "$25"; } },
      { t: 450, run: () => { press(""); display.textContent = "$25.00"; pad.classList.add("lift"); kb.classList.add("on"); } },
    ], 3800);
  },
  reconcile(host) {
    const box = h("input", { type: "checkbox", checked: true, tabindex: "-1" });
    const diff = h("p", { class: "wn-diff", text: "Difference $25.00" });
    const row = h("label", { class: "wn-row" }, box, h("span", { text: "Kroger" }), h("span", { class: "wn-amt out on", text: "−$25.00" }));
    host.append(stageBar(), h("div", { class: "wn-stack" },
      h("p", { class: "wn-k", text: "Statement $1,000.00" }),
      diff,
      row,
    ));
    return play([
      { t: 0, run: () => { box.checked = true; diff.textContent = "Difference $25.00"; diff.classList.remove("ok"); row.classList.remove("off"); } },
      { t: 1100, run: () => { box.checked = false; row.classList.add("off"); } },
      { t: 450, run: () => { diff.textContent = "Matches"; diff.classList.add("ok"); } },
    ], 3600);
  },
  activity(host) {
    const q = h("span", { class: "wn-q", text: "" });
    const caret = h("span", { class: "wn-caret", text: "" });
    const extra = h("div", { class: "wn-row wn-extra" }, h("span", { text: "Starting balance" }), h("span", { text: "$1,000.00" }));
    host.append(stageBar(), h("div", { class: "wn-stack" },
      h("div", { class: "wn-search" }, q, caret),
      h("div", { class: "wn-cardlet" },
        h("div", { class: "wn-row" }, h("strong", { text: "Kroger" }), h("span", { class: "wn-amt out on", text: "−$42.18" })),
        h("span", { class: "wn-meta", text: "Nov 26 · Checking · Groceries" }),
      ),
      extra,
    ));
    const type = (s) => { q.textContent = s; };
    return play([
      { t: 0, run: () => { type(""); extra.classList.remove("gone"); } },
      { t: 500, run: () => type("K") },
      { t: 280, run: () => type("Kr") },
      { t: 280, run: () => type("Kro") },
      { t: 350, run: () => extra.classList.add("gone") },
    ], 3600);
  },
  plan(host) {
    const month = h("div", { class: "wn-month", text: "November 2026" });
    const cover = h("div", { class: "wn-cover", text: "Cover overspending" });
    const avail = h("span", { class: "wn-amt", text: "$0.00" });
    const list = h("div", { class: "wn-plan-list" },
      h("div", { class: "wn-row" }, h("span", { text: "Groceries" }), avail),
      h("div", { class: "wn-row muted-row" }, h("span", { text: "Gas" }), h("span", { text: "$0.00" })),
      cover,
    );
    host.append(stageBar(), h("div", { class: "wn-stack" },
      month,
      h("div", { class: "wn-rta" }, h("span", { class: "wn-k", text: "Ready to Assign" }), h("strong", { text: "$800.00" })),
      list,
    ));
    return play([
      { t: 0, run: () => { list.classList.remove("scrolled"); avail.classList.remove("on", "out"); avail.textContent = "$0.00"; cover.classList.remove("on"); month.classList.remove("set"); } },
      { t: 400, run: () => month.classList.add("set") },
      { t: 700, run: () => list.classList.add("scrolled") },
      { t: 500, run: () => { avail.textContent = "−$42.18"; avail.classList.add("on", "out"); cover.classList.add("on"); } },
    ], 4000);
  },
  inbox(host) {
    const badge = h("span", { class: "wn-badge", text: "3" });
    const notes = ["Overspending in November", "Reconcile Checking", "Visa payment is short"].map((t) => h("div", { class: "wn-note", text: t }));
    host.append(stageBar(), h("div", { class: "wn-stack" },
      h("div", { class: "wn-bell" }, icon("bell"), badge),
      ...notes,
    ));
    return play([
      { t: 0, run: () => { badge.classList.remove("on"); notes.forEach((n) => n.classList.remove("on")); } },
      { t: 350, run: () => badge.classList.add("on") },
      { t: 400, run: () => notes[0].classList.add("on") },
      { t: 220, run: () => notes[1].classList.add("on") },
      { t: 220, run: () => notes[2].classList.add("on") },
    ], 3800);
  },
  zoom(host) {
    const dot = h("span", { class: "wn-tap" });
    const label = h("p", { class: "wn-k", text: "Tap" });
    host.append(stageBar(), h("div", { class: "wn-stack wn-center" }, dot, label));
    return play([
      { t: 0, run: () => { dot.className = "wn-tap"; label.textContent = "Tap"; } },
      { t: 420, run: () => { dot.classList.add("on"); label.textContent = "Tap"; } },
      { t: 160, run: () => { dot.classList.remove("on"); } },
      { t: 140, run: () => { dot.classList.add("on"); label.textContent = "Tap again"; } },
      { t: 280, run: () => { dot.classList.add("hold"); label.textContent = "Same size"; } },
    ], 2800);
  },
  ledger(host) {
    const left = h("span", { class: "wn-amt", text: "$0.00" });
    const sub = h("p", { class: "wn-meta", text: "Assigned $0.00" });
    host.append(stageBar(), h("div", { class: "wn-stack" },
      h("p", { class: "wn-k", text: "Ready to Assign" }),
      h("p", { class: "wn-diff ok", text: "$800.00" }),
      h("div", { class: "wn-row" }, h("span", { text: "Groceries" }), left),
      sub,
    ));
    return play([
      { t: 500, run: () => { left.textContent = "−$25.00"; left.className = "wn-amt on out"; sub.textContent = "Assigned $0.00 · Activity −$25.00"; } },
      { t: 900, run: () => { left.textContent = "$95.00"; left.className = "wn-amt on in"; sub.textContent = "Assigned $120.00 · Activity −$25.00"; } },
    ], 3200);
  },
  lists(host) {
    const rows = ["Kroger  −$25.00", "Checking  $975.00", "Electric  due on the 12th"].map((t) => h("div", { class: "wn-line", text: t }));
    host.append(stageBar(), h("div", { class: "wn-stack wn-lines" }, ...rows));
    return play([
      { t: 180, run: () => rows[0].classList.add("on") },
      { t: 260, run: () => rows[1].classList.add("on") },
      { t: 260, run: () => rows[2].classList.add("on") },
    ], 2600);
  },
};

export function openWhatsNew(slides) {
  const list = slides?.length ? slides : taggedSlides();
  if (!list.length) return;
  let index = 0;
  let stop = () => {};
  let onKey = null;
  const sheet = openSheet({
    title: "What's new",
    onClose: () => { stop(); if (onKey) window.removeEventListener("keydown", onKey, true); },
    body: (host) => {
      const stage = h("div", { class: "wn-stage" });
      const kicker = h("p", { class: "kicker" });
      const title = h("h3", { class: "wn-title", tabindex: "-1" });
      const copy = h("p", { class: "lede" });
      const dots = h("div", { class: "wn-dots", role: "tablist", "aria-label": "Updates" });
      const prev = btn("Back", { kind: "ghost" });
      const next = btn("Next", {});
      host.append(stage, kicker, title, copy, h("div", { class: "wn-nav" }, prev, dots, next));

      const go = (dir) => {
        const n = index + dir;
        if (n < 0 || n >= list.length) return;
        index = n;
        show();
      };
      prev.addEventListener("click", () => go(-1));
      next.addEventListener("click", () => {
        if (index === list.length - 1) sheet.close();
        else go(1);
      });
      const show = () => {
        stop();
        const s = list[index];
        kicker.textContent = list.length > 1 ? `Version ${s.version} · ${index + 1} of ${list.length}` : `Version ${s.version}`;
        title.textContent = s.title;
        copy.textContent = s.body;
        stage.replaceChildren();
        stop = (demos[s.demo] || demos.colors)(stage);
        prev.disabled = index === 0;
        const label = next.querySelector("span");
        if (label) label.textContent = index === list.length - 1 ? "Done" : "Next";
        dots.replaceChildren(...list.map((slide, i) => h("button", {
          class: `wn-dot ${i === index ? "on" : ""}`,
          type: "button",
          role: "tab",
          "aria-label": slide.title,
          "aria-selected": i === index ? "true" : "false",
          onclick: () => { index = i; show(); },
        }, h("i"))));
        dots.hidden = list.length < 2;
      };
      onKey = (e) => {
        if (!document.body.contains(stage)) return;
        if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); go(1); }
        if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); go(-1); }
      };
      window.addEventListener("keydown", onKey, true);
      let x0 = null;
      stage.addEventListener("pointerdown", (e) => { x0 = e.clientX; });
      stage.addEventListener("pointerup", (e) => {
        if (x0 == null) return;
        const dx = e.clientX - x0;
        if (dx > 48) go(-1);
        else if (dx < -48) go(1);
        x0 = null;
      });
      show();
    },
  });
  sheet.content.parentElement.classList.add("wn-sheet");
  return sheet;
}

let announcing = false;
export async function announceIfUpdated(ctx) {
  if (announcing) return;
  const signedIn = (ctx.state?.users || []).some((u) => u.userId === ctx.state?.activeUserId);
  if (!ctx.state?.setupComplete || !signedIn) {
    if (!ctx.state?.setupComplete) {
      const seen = await deviceGet("seenVersion");
      if (!seen) await deviceSet("seenVersion", APP_VERSION);
    }
    return;
  }
  const seen = await deviceGet("seenVersion");
  if (seen === APP_VERSION) return;
  const slides = slidesAfter(seen);
  announcing = true;
  await deviceSet("seenVersion", APP_VERSION);
  announcing = false;
  if (!slides.length) return;
  toast(`App updated to version ${APP_VERSION}`, {
    label: "What's new",
    ms: 16000,
    action: () => openWhatsNew(slides),
  });
}
