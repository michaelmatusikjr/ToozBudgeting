/**
 * oauth.html: where Plaid sends people back after a bank's own sign-in (Chase OAuth).
 *
 * Plaid Link has to be opened again here with the same link token and this page's full address
 * (receivedRedirectUri). The link token normally comes from this browser's localStorage, but on iPhone the
 * home-screen app and Safari don't share storage, and the bank's "Return to ToozBudgeting" opens Safari.
 * So the Worker also keeps the Link session: sign in with Google here if needed, fetch it, finish the
 * connection in this browser, and tell the person to go back to the app (which notices and closes its Link).
 *
 * This page always shows a status, a reason code when something fails, and a way back. Never a blank screen.
 */
import { account, renderGoogleButton, withCode, ApiError } from "./account.js?v=154";
import { loadPlaidLink, exchangePublicToken, markRepaired, readLocalLink, clearLocalLink, pendingLinkSession, linkSessionEvent } from "./banksync.js?v=154";

import { APP_VERSION } from "./util.js?v=154";

window.__oauthStarted = true;
document.getElementById("ver") && (document.getElementById("ver").textContent = `ToozBudgeting ${APP_VERSION}`);
const $ = (id) => document.getElementById(id);
const isStandalone = () => !!(navigator.standalone || matchMedia?.("(display-mode: standalone)")?.matches);

function show(title, msg, { code = "", error = false, extra = null, back = "./" } = {}) {
  $("title").textContent = title;
  $("msg").textContent = msg;
  $("msg").className = error ? "err" : "";
  $("code").textContent = code;
  $("extra").replaceChildren(...(extra ? [extra] : []));
  $("back").href = back;
}

function retryButton() {
  const b = document.createElement("button");
  b.className = "btn"; b.type = "button"; b.textContent = "Try again";
  b.onclick = () => location.reload();
  return b;
}

async function signInHere() {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.className = "gsi-host";
    const err = document.createElement("p");
    err.className = "err";
    const box = document.createElement("div");
    box.append(host, err);
    show("Sign in to finish", "Your bank sent you back to Safari, which isn’t signed in to ToozBudgeting yet. Sign in with the same Google account to finish connecting.", { extra: box, code: "OAUTH_NEEDS_SIGNIN" });
    renderGoogleButton(host, { onSignedIn: (acct) => resolve(acct), onError: (m) => { err.textContent = m; } })
      .catch((e) => { err.textContent = withCode(e.message, "GSI_LOAD"); });
  });
}

async function main() {
  const href = location.href;
  if (!/[?&]oauth_state_id=/.test(location.search)) {
    show("Nothing to finish here", "This page is only for coming back from your bank’s sign-in. Go back to ToozBudgeting and connect the bank from Settings › Bank sync.", { code: "OAUTH_NO_STATE" });
    return;
  }
  // Opened as Plaid's pop-up (computer browsers): the Link that opened it finishes on its own.
  if (window.opener && !window.opener.closed) {
    show("Done here", "Close this window and go back to ToozBudgeting. The connection finishes there.", { code: "" });
    setTimeout(() => { try { window.close(); } catch { /* ignore */ } }, 800);
    return;
  }
  const local = readLocalLink();
  let acct = await account();
  if (!acct?.token) acct = await signInHere();
  show("Finishing your bank connection…", "Opening Plaid to finish up.");

  let link = local ? { linkToken: local.token, mode: local.mode, itemId: local.itemId, id: local.linkSessionId } : null;
  if (!link) {
    try { link = (await pendingLinkSession()).link; }
    catch (e) {
      const code = e instanceof ApiError ? (e.code || `HTTP_${e.status}`) : "NETWORK";
      show("Couldn’t finish connecting", e.message, { error: true, code, extra: retryButton() });
      return;
    }
  }
  let Plaid;
  try { Plaid = await loadPlaidLink(); }
  catch (e) { show("Couldn’t load Plaid", e.message, { error: true, code: "PLAID_LOAD", extra: retryButton() }); return; }

  // Same browser as the app (not the iPhone home-screen app): go straight back when done.
  const fromSafariConnect = local?.from === "connect";
  const backTo = local && !fromSafariConnect && !isStandalone() ? "./#settings/bank" : "./";
  const handler = Plaid.create({
    token: link.linkToken,
    receivedRedirectUri: href,
    onSuccess: async (publicToken, metadata) => {
      show("Saving the connection…", "Almost done.");
      try {
        let name = metadata?.institution?.name || "Your bank";
        if (link.mode === "update") await markRepaired(link.itemId, link.id);
        else name = (await exchangePublicToken(publicToken, metadata, link.id)).item?.institution || name;
        clearLocalLink();
        const verb = link.mode === "update" ? "reconnected" : "connected";
        if (local && !fromSafariConnect) {
          show(`${name} ${verb}`, "Taking you back to ToozBudgeting…", { back: backTo });
          setTimeout(() => location.replace(backTo), 900);
        } else {
          show(`${name} ${verb}`, "Go back to the ToozBudgeting app on your home screen to choose where each account goes. You can close Safari.", { back: backTo });
        }
      } catch (e) {
        show("Couldn’t save the connection", e.message, { error: true, code: e.code || (e.status ? `HTTP_${e.status}` : "EXCHANGE_FAILED"), extra: retryButton() });
      }
      try { handler.destroy(); } catch { /* ignore */ }
    },
    onExit: (err, metadata) => {
      linkSessionEvent(link.id, "exited", err?.error_code || "USER_EXIT");
      try { handler.destroy(); } catch { /* ignore */ }
      if (err) show("The bank connection didn’t finish", err.display_message || err.error_message || "Plaid stopped before the bank was connected.", { error: true, code: err.error_code || "LINK_EXIT", extra: retryButton() });
      else show("Bank connection canceled", "Nothing was connected. You can connect the bank again from Settings › Bank sync.", { code: metadata?.status ? `LINK_${String(metadata.status).toUpperCase()}` : "LINK_CANCELED" });
    },
  });
  handler.open();
}

main().catch((e) => show("Something went wrong", e?.message || String(e), { error: true, code: "OAUTH_ERROR", extra: retryButton() }));
