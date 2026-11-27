/** Settings > Bank sync: connect banks through Plaid (owners), map accounts, and sync. Uses the household sign-in. */
import { h, btn, openSheet, field, textInput, toast, confirmDialog } from "../ui.js?v=154";
import { bankSettings, setBankLink, setBankSettings } from "../bankmap.js?v=154";
import {
  bankState, bankConfig, setBankConfig, bankAccess, listItems, linkToken, openLink,
  pendingOAuth, pullBank, requestSync, disconnectItem, rememberItems, plainBankError, bankHealth, BANK_DEFAULTS,
} from "../banksync.js?v=154";
import { isIOS, isStandalone } from "../pwa.js?v=154";

const STATUS = {
  ok: ["Connected", ""],
  expiring: ["Sign in again soon", "bad"],
  login_required: ["Needs you to sign in", "bad"],
  error: ["Having trouble", "bad"],
};

/** The short status line and button for the Settings page. */
export async function bankSection(ctx) {
  const s = await bankState();
  const access = await bankAccess();
  let text = "Sign in with Google above to bring in new bank transactions automatically.";
  if (access.signedIn) {
    const items = s.items?.items || [];
    const trouble = items.find((i) => i.status !== "ok");
    if (s.error) text = s.error;
    else if (trouble) text = `${trouble.institution}: ${STATUS[trouble.status]?.[0] || "needs attention"}.`;
    else if (items.length) text = `${items.length} bank${items.length === 1 ? "" : "s"} connected.${s.lastPull ? ` Checked ${new Date(s.lastPull).toLocaleString()}.` : ""}`;
    else text = access.canManage ? "Connect a bank to start." : "No banks connected yet. A household owner can connect them.";
  }
  return [
    h("p", { class: "hint", text }),
    btn(access.signedIn && (s.items?.items || []).length ? "Bank sync" : "Set up bank sync", { block: true, kind: access.signedIn ? "ghost" : "primary", disabled: !access.signedIn, onClick: () => openBankSheet(ctx) }),
  ];
}

export function openBankSheet(ctx) {
  let host = null;
  const sheet = openSheet({ title: "Bank sync", body: (el) => { host = el; } });
  const repaint = async () => {
    if (!host) return;
    try { await paint(ctx, host, repaint, sheet); }
    catch (e) { host.replaceChildren(h("p", { class: "error", text: plainBankError(e) })); }
  };
  repaint();
  const resume = pendingOAuth();
  if (resume) setTimeout(() => runLink(ctx, resume, repaint), 50);
  return sheet;
}

async function paint(ctx, host, repaint, sheet) {
  const s = await bankState();
  const access = await bankAccess();
  if (!access.signedIn) { paintSignedOut(host); return; }
  host.replaceChildren(h("p", { class: "hint", text: "Loading banks…" }));
  let data = s.items || { items: [], used: 0, cap: 10 };
  let offline = null;
  try {
    data = await listItems();
    rememberItems(ctx, data.items);
  } catch (e) {
    offline = plainBankError(e);
    if (!(await bankAccess()).signedIn) { paintSignedOut(host, offline); return; }
  }
  const owner = access.canManage;
  const budget = ctx.budget();
  const settings = bankSettings(budget);
  const kids = [];
  kids.push(h("p", { class: "lede", text: "New transactions from your banks come in on their own, for everyone in the household. Your bank sign-in goes to Plaid, never to this app or the sync server." }));
  if (offline) kids.push(h("p", { class: "error", text: offline }));
  if (s.error && !offline) kids.push(h("p", { class: "error", text: s.error }));
  if (!owner) kids.push(h("p", { class: "hint", text: access.canApply ? "Only a household owner can connect banks or choose where accounts go. You can sync." : "You have view-only access to bank sync." }));
  if (owner) kids.push(h("p", { class: "hint", text: `${data.used} of ${data.cap} free bank logins used. Each new bank uses one for good, even if it’s disconnected later. Use Reconnect to fix a bank instead of adding it again.` }));

  for (const item of data.items || []) kids.push(itemCard(ctx, item, settings, data, repaint, owner));

  if (s.waiting) kids.push(h("p", { class: "hint", text: "Some transactions are waiting until an owner chooses an account above." }));
  const full = data.used >= data.cap;
  if (owner) kids.push(btn(full ? "No free bank logins left" : "Connect a bank", { block: true, disabled: full || !!offline, onClick: () => confirmDialog({
    title: "Connect a bank?",
    message: `This uses 1 of your ${data.cap} free bank logins (${data.cap - data.used} left), and it can’t be given back. Connect each bank once. Start with your main bank.`,
    confirm: "Continue",
    onConfirm: () => startLink(ctx, null, data, repaint),
  }) }));

  const cut = h("input", { class: "input", type: "date", value: settings.cutover });
  cut.addEventListener("change", () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cut.value)) return;
    ctx.updateBudget((b) => setBankSettings(b, { cutover: cut.value }));
    toast("Saved. Only transactions on or after that day come in.");
  });
  const pend = h("input", { type: "checkbox", checked: settings.includePending });
  pend.addEventListener("change", () => ctx.updateBudget((b) => setBankSettings(b, { includePending: pend.checked })));
  if (owner) kids.push(
    h("h3", { class: "kicker", text: "Options" }),
    field("Bring in transactions from", cut),
    h("label", { class: "choice" }, pend, h("span", {},
      h("strong", { text: "Include pending transactions" }),
      h("span", { class: "hint", text: "Off: only posted ones. On: pending ones show up early and update when they post." }),
    )),
  );
  if (access.canApply) kids.push(btn("Sync now", { block: true, kind: "ghost", disabled: !!offline, onClick: async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try {
      const res = await requestSync();
      const errs = (res.results || []).filter((r) => r.error);
      const out = await pullBank(ctx);
      toast(errs.length ? `${out.text || "Synced"}. ${errs.length} bank${errs.length === 1 ? "" : "s"} need attention.` : (out.text || "Synced"));
    } catch (err) { toast(plainBankError(err)); }
    repaint();
  } }));
  kids.push(h("p", { class: "hint", text: s.lastPull ? `Last checked ${new Date(s.lastPull).toLocaleString()}. Bank sync also checks when the app opens, and the server checks twice a day.` : "Bank sync checks when the app opens, and the server checks twice a day." }));
  kids.push(btn("Server", { kind: "quiet", block: true, onClick: () => editServer(repaint) }));
  host.replaceChildren(...kids);
  void sheet;
}

function paintSignedOut(host, message) {
  host.replaceChildren(
    h("p", { class: "lede", text: "Bring new transactions in from your bank automatically, through Plaid." }),
    h("p", { class: "hint", text: message || "First, sign in with Google in Settings › Household. Bank sync uses your household sign-in, so there’s nothing to pair." }),
    btn("Server", { kind: "quiet", block: true, onClick: () => editServer(() => {}) }),
  );
}

function itemCard(ctx, item, settings, data, repaint, owner) {
  const [label, tone] = STATUS[item.status] || ["Needs attention", "bad"];
  const needs = item.status !== "ok" || item.newAccounts;
  const budget = ctx.budget();
  const rows = (item.accounts || []).map((a) => {
    const sel = h("select", { class: "input" },
      h("option", { value: "", text: "Choose where these go…" }),
      h("option", { value: "skip", text: "Don’t bring these in" }),
    );
    const accts = (budget.accounts || []).filter((x) => !x.archived);
    const cards = (budget.creditCards || []).filter((x) => !x.archived);
    if (accts.length) sel.append(h("optgroup", { label: "Accounts" }, ...accts.map((x) => h("option", { value: x.id, text: x.name }))));
    if (cards.length) sel.append(h("optgroup", { label: "Cards" }, ...cards.map((x) => h("option", { value: x.id, text: x.name }))));
    sel.value = settings.accounts[a.id]?.target || "";
    sel.disabled = !owner;
    sel.addEventListener("change", async () => {
      ctx.updateBudget((b) => setBankLink(b, a.id, sel.value, { itemId: item.itemId, institution: item.institution, name: a.name, mask: a.mask || "", type: a.type || "", subtype: a.subtype || "" }));
      if (sel.value && sel.value !== "skip") {
        try { const out = await pullBank(ctx); if (out?.stats?.added) toast(`Bank sync: ${out.text}`); } catch { /* shown later */ }
      }
    });
    return field(`${a.name}${a.mask ? ` ••${a.mask}` : ""}`, sel);
  });
  const when = item.lastSyncAt ? `Last update ${new Date(item.lastSyncAt).toLocaleString()}.` : "Waiting for the first transactions from the bank.";
  const expires = item.consentExpiresAt ? ` Access ends ${new Date(item.consentExpiresAt).toLocaleDateString()}. Reconnect to renew it.` : "";
  const newAcc = item.newAccounts ? " The bank has new accounts. Reconnect to add them." : "";
  return h("div", { class: "pair bank-item" },
    h("div", { class: "row gap", style: "justify-content:space-between;align-items:center" },
      h("strong", { text: item.institution || "Bank" }),
      h("span", { class: `pill ${tone}`, text: item.newAccounts && item.status === "ok" ? "New accounts" : label }),
    ),
    h("p", { class: "hint", text: when + expires + newAcc }),
    ...rows,
    !owner ? null : h("div", { class: "row gap" },
      btn("Reconnect", { kind: needs ? "primary" : "quiet", onClick: () => startLink(ctx, item.itemId, data, repaint) }),
      btn("Disconnect", { kind: "quiet", onClick: () => confirmDialog({
        title: `Disconnect ${item.institution}?`,
        message: "Transactions already in your budget stay. The free bank login it used doesn’t come back, so only do this if you’re done with this bank.",
        confirm: "Disconnect", danger: true,
        onConfirm: async () => {
          try { await disconnectItem(item.itemId); toast("Disconnected"); } catch (e) { toast(plainBankError(e)); }
          repaint();
        },
      }) }),
    ),
  );
}

/* ---------- iPhone home-screen app: connect in Safari ---------- */

// On iPhone, a bank's own sign-in (Chase OAuth, often App-to-App) can't hand back to a home-screen app: Plaid's
// bank window inside the app goes white and the bank's "Return to ToozBudgeting" opens Safari. So the home-screen
// app sends bank connections to connect.html in Safari, where Plaid's mobile flow works, and picks up the result.
const SAFARI_KEY = "toozbudgeting:bank:safari";
export const useSafariForLink = () => isIOS() && isStandalone();

export function connectUrl(itemId) {
  const u = new URL("./connect.html", location.href);
  u.search = itemId ? `?item=${encodeURIComponent(itemId)}` : "";
  u.hash = "";
  return u.href;
}
/** iOS 17+ opens x-safari-https:// links in Safari, even from a home-screen app. */
export const safariUrl = (href) => href.replace(/^https:/, "x-safari-https:");

let watching = null;
function watchSafari(ctx, repaint, before) {
  try { localStorage.setItem(SAFARI_KEY, JSON.stringify({ at: Date.now(), before })); } catch { /* ignore */ }
  if (watching) return;
  const check = async () => {
    if (document.visibilityState !== "visible") return;
    let rec = null;
    try { rec = JSON.parse(localStorage.getItem(SAFARI_KEY) || "null"); } catch { /* ignore */ }
    if (!rec || Date.now() - rec.at > 30 * 60000) { stop(); return; }
    try {
      const data = await listItems();
      const fresh = (data.items || []).find((i) => !rec.before.includes(`${i.itemId}:${i.status}`) && i.status === "ok");
      if (!fresh) return;
      rememberItems(ctx, data.items);
      stop();
      toast(`${fresh.institution || "Bank"} connected in Safari. Choose where each account goes.`, { ms: 7000 });
      repaint?.();
    } catch { /* try again on the next visit */ }
  };
  const stop = () => {
    document.removeEventListener("visibilitychange", check);
    clearInterval(watching); watching = null;
    try { localStorage.removeItem(SAFARI_KEY); } catch { /* ignore */ }
  };
  document.addEventListener("visibilitychange", check);
  watching = setInterval(check, 5000);
}

function openSafariSheet(ctx, itemId, data, repaint) {
  const href = connectUrl(itemId);
  const before = (data.items || []).map((i) => `${i.itemId}:${i.status}`);
  const out = h("p", { class: "hint", text: "" });
  const sheet = openSheet({ title: itemId ? "Reconnect in Safari" : "Connect in Safari", body: (host) => {
    host.append(
      h("p", { class: "lede", text: "On iPhone, banks like Chase can’t send you back to a home-screen app, so bank connections finish in Safari." }),
      h("p", { class: "hint", text: "Safari opens ToozBudgeting’s connect page. Sign in with Google there (same account), connect your bank, then come back here. The new bank shows up on its own." }),
      btn("Open Safari to connect", { block: true, onClick: () => { watchSafari(ctx, () => { try { sheet.close(); } catch { /* already closed */ } repaint?.(); }, before); out.textContent = "Opening Safari… If nothing happens, copy the link and paste it into Safari."; location.href = safariUrl(href); } }),
      btn("Copy link for Safari", { block: true, kind: "ghost", onClick: async () => {
        watchSafari(ctx, () => { try { sheet.close(); } catch { /* already closed */ } repaint?.(); }, before);
        try { await navigator.clipboard.writeText(href); out.textContent = "Copied. Open Safari, paste it in the address bar, and go."; }
        catch { out.textContent = href; }
      } }),
      out,
      btn("Try here anyway", { block: true, kind: "quiet", onClick: () => { sheet.close(); startLink(ctx, itemId, data, repaint, { here: true }); } }),
    );
  } });
}

async function startLink(ctx, itemId, data, repaint, { here = false } = {}) {
  if (!here && useSafariForLink()) { openSafariSheet(ctx, itemId, data, repaint); return; }
  try {
    const res = await linkToken(itemId);
    if (res.warning) toast(res.warning, { ms: 7000 });
    await runLink(ctx, { token: res.linkToken, mode: res.mode, itemId, linkSessionId: res.linkSessionId, connected: (data.items || []).map((i) => i.institutionId).filter(Boolean) }, repaint);
  } catch (e) { toast(plainBankError(e)); }
}

async function runLink(ctx, { token, mode, itemId, linkSessionId, connected, receivedRedirectUri }, repaint) {
  let ids = connected;
  if (!ids) {
    const s = await bankState();
    ids = (s.items?.items || []).map((i) => i.institutionId).filter(Boolean);
  }
  try {
    await openLink({
      token, mode, itemId, linkSessionId, receivedRedirectUri, connectedInstitutions: ids,
      onDuplicate: (name) => toast(`${name || "That bank"} is already connected. Use Reconnect on it instead.`, { ms: 7000 }),
      onDone: async (r) => {
        if (r.ok) toast(r.mode === "update" ? "Reconnected" : `${r.item?.institution || "Bank"} connected${r.elsewhere ? " in Safari" : ""}. Choose where each account goes.`, { ms: 6000 });
        else if (r.message) toast(r.message, { ms: 7000 });
        repaint();
      },
    });
  } catch (e) { toast(plainBankError(e)); }
}

async function editServer(repaint) {
  const cfg = await bankConfig();
  const url = textInput({ value: cfg.serverUrl });
  const out = h("p", { class: "hint", text: "" });
  const sheet = openSheet({ title: "Bank sync server", body: (host) => {
    host.append(
      field("Server address", url),
      out,
      btn("Check", { kind: "ghost", block: true, onClick: async () => {
        await setBankConfig({ serverUrl: url.value });
        const hl = await bankHealth();
        out.textContent = !hl.reachable ? `Can’t reach it: ${hl.error}` : hl.ok ? `Ready. Plaid ${hl.plaidEnv}.` : "Reachable, but the server is missing a setting.";
      } }),
      btn("Save", { block: true, onClick: async () => { await setBankConfig({ serverUrl: url.value }); sheet.close(); repaint(); } }),
      btn("Use default", { kind: "quiet", block: true, onClick: async () => { await setBankConfig({ serverUrl: BANK_DEFAULTS.serverUrl }); sheet.close(); repaint(); } }),
    );
  } });
}
