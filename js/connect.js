/**
 * connect.html: connect (or reconnect) a bank in Safari.
 *
 * On iPhone, a bank's own sign-in (Chase OAuth, often through the Chase app) can't hand back to a home-screen
 * app: the bank window inside the app goes white and the "Return to ToozBudgeting" link opens Safari. So the
 * home-screen app sends people here, in Safari, where Plaid's normal mobile flow works end to end: Link opens the
 * bank in a new tab, the bank returns to oauth.html in Safari (same storage, same link token), and the
 * connection finishes. The home-screen app picks up the new bank when the person goes back to it.
 *
 * Always shows a status, a reason code when something fails, and a way back. Never a blank screen.
 */
import { APP_VERSION } from "./util.js?v=154";
import { account, renderGoogleButton, withCode, ApiError } from "./account.js?v=154";
import { listItems, linkToken, openLink, bankAccess } from "./banksync.js?v=154";

window.__oauthStarted = true;
const $ = (id) => document.getElementById(id);
$("ver") && ($("ver").textContent = `ToozBudgeting ${APP_VERSION}`);

function show(title, msg, { code = "", error = false, extra = null } = {}) {
  $("title").textContent = title;
  $("msg").textContent = msg;
  $("msg").className = error ? "err" : "";
  $("code").textContent = code;
  $("extra").replaceChildren(...(extra ? [extra] : []));
}
function button(label, onClick, ghost = false) {
  const b = document.createElement("button");
  b.className = ghost ? "btn ghost" : "btn"; b.type = "button"; b.textContent = label; b.onclick = onClick;
  return b;
}
const errCode = (e) => (e instanceof ApiError ? (e.code || `HTTP_${e.status}`) : e?.code || "NETWORK");

async function signInHere() {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.className = "gsi-host";
    const err = document.createElement("p");
    err.className = "err";
    const box = document.createElement("div");
    box.append(host, err);
    show("Sign in to connect", "Sign in with the same Google account you use in the ToozBudgeting app. Safari keeps its own sign-in.", { extra: box, code: "CONNECT_NEEDS_SIGNIN" });
    renderGoogleButton(host, { onSignedIn: (acct) => resolve(acct), onError: (m) => { err.textContent = m; } })
      .catch((e) => { err.textContent = withCode(e.message, "GSI_LOAD"); });
  });
}

async function main() {
  const params = new URLSearchParams(location.search);
  const itemId = params.get("item") || null;
  const acct = await account();
  if (!acct?.token) await signInHere();
  const access = await bankAccess();
  if (!access.canManage) {
    show("Only an owner can connect banks", "Ask a household owner to connect the bank.", { error: true, code: "NOT_OWNER" });
    return;
  }
  show("Getting Plaid ready…", "One moment.");
  let items, res;
  try {
    items = await listItems();
    if (!itemId && items.used >= items.cap) { show("No free bank logins left", `All ${items.cap} free bank logins are used. Use Reconnect on a bank instead.`, { error: true, code: "ITEM_CAP" }); return; }
    res = await linkToken(itemId);
  } catch (e) {
    show("Couldn’t start connecting", e.message, { error: true, code: errCode(e), extra: button("Try again", () => location.reload()) });
    return;
  }
  const start = () => {
    show(itemId ? "Reconnecting your bank…" : "Connecting your bank…", "Follow the steps in Plaid. If your bank opens its own app, come back to Safari when it says to return.");
    openLink({
      token: res.linkToken, mode: res.mode, itemId, linkSessionId: res.linkSessionId, from: "connect",
      connectedInstitutions: (items.items || []).map((i) => i.institutionId).filter(Boolean),
      onDuplicate: (name) => show("Already connected", `${name || "That bank"} is already connected. Use Reconnect on it in the app instead, so you don’t use another free login.`, { code: "DUPLICATE" }),
      onDone: (r) => {
        if (r.ok) {
          const name = r.item?.institution || "Your bank";
          show(`${name} ${r.mode === "update" ? "reconnected" : "connected"}`, "Go back to the ToozBudgeting app on your home screen to choose where each account goes. You can close Safari.", { code: "" });
        } else if (r.duplicate) {
          /* message already shown */
        } else if (r.cancelled) {
          show("Nothing was connected", r.message || "You closed Plaid before the bank was connected.", { code: "LINK_CANCELED", extra: button("Start again", () => location.reload()) });
        } else {
          show("The bank connection didn’t finish", r.message || "Plaid stopped before the bank was connected.", { error: true, code: "LINK_EXIT", extra: button("Start again", () => location.reload()) });
        }
      },
    }).catch((e) => show("Couldn’t load Plaid", e.message, { error: true, code: "PLAID_LOAD", extra: button("Try again", () => location.reload()) }));
  };
  // Safari only lets Plaid open the bank's tab from a tap, so the first step is a button.
  show(itemId ? "Reconnect your bank" : "Connect your bank", "Tap Continue to open Plaid. This uses one of your free bank logins only when a bank actually connects.", { extra: button("Continue", start) });
}

main().catch((e) => show("Something went wrong", e?.message || String(e), { error: true, code: "CONNECT_ERROR", extra: button("Try again", () => location.reload()) }));
