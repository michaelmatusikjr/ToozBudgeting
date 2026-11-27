/** Settings > Household: who's signed in, the people in the household, invites, roles, and sync status. */
import { h, btn, openSheet, field, textInput, toast, confirmDialog } from "../ui.js?v=152";
import {
  account, renderGoogleButton, signOut, listMembers, invite, revokeInvite, setMember, removeMember, setMyName,
  renameHousehold, refreshMe, ROLE_LABEL, ROLE_HINT, shareInvite, inviteMessage,
} from "../account.js?v=152";
import { syncNow, syncStatus, preSyncBackup } from "../sync.js?v=152";

/** "Share invite link": the share sheet, or copy. If neither works, show the message to copy by hand. */
function shareButton(inv, householdName, { label = "Share invite link", kind = "ghost", block = false } = {}) {
  return btn(label, { kind, block, onClick: async () => {
    const how = await shareInvite(inv, householdName);
    if (how === "copied") toast("Invite copied. Paste it in a text or email.");
    else if (how === "manual") {
      openSheet({ title: "Invite message", body: (el) => {
        const ta = h("textarea", { class: "input", rows: 5, readonly: true });
        ta.value = inviteMessage(inv, householdName);
        el.append(h("p", { class: "hint", text: "Copy this and send it to them." }), ta);
        setTimeout(() => { ta.focus(); ta.select(); }, 50);
      } });
    }
  } });
}

export function avatar(user, size = 40) {
  const initials = String(user?.displayName || user?.name || user?.email || "?").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  if (user?.picture) {
    const img = h("img", { class: "avatar", src: user.picture, alt: "", width: size, height: size, referrerpolicy: "no-referrer", loading: "lazy" });
    img.addEventListener("error", () => img.replaceWith(h("span", { class: "avatar", style: `width:${size}px;height:${size}px`, text: initials })));
    return img;
  }
  return h("span", { class: "avatar", style: `width:${size}px;height:${size}px`, text: initials });
}

function when(ts) { return ts ? new Date(ts).toLocaleString() : "not yet"; }

/** The Settings block. */
export async function householdSection(ctx) {
  const a = await account();
  if (!a?.token) {
    const host = h("div", { class: "gsi-host" });
    const err = h("p", { class: "error", text: a?.signedOutReason || "" });
    setTimeout(() => renderGoogleButton(host, {
      onSignedIn: (acct) => ctx.accountSignedIn(acct),
      onError: (m) => { err.textContent = m; },
    }), 0);
    return [
      h("p", { class: "hint", text: "Sign in with Google to share this budget with your household. Everyone sees the same budget on every phone and computer, and bank transactions come in for all of you." }),
      host, err,
    ];
  }
  const me = a.me || {};
  const st = syncStatus();
  const line = st.error || a.syncError ? `Sync problem: ${st.error || a.syncError}` : `Synced ${when(st.lastSyncAt || a.lastSyncAt)}.`;
  const kids = [
    h("div", { class: "who" },
      avatar(me.user, 44),
      h("span", {},
        h("strong", { text: me.user?.displayName || me.user?.name || "Signed in" }),
        h("span", { class: "muted", text: `${me.user?.email || ""} · ${ROLE_LABEL[me.role] || me.role}` }),
      ),
    ),
    h("p", { class: "hint", text: `${me.household?.name || "Household"}. ${line}${me.role === "viewer" ? " You have view-only access, so changes aren’t saved." : ""}` }),
    btn("People", { kind: "ghost", block: true, onClick: () => openPeople(ctx) }),
    btn("Sync now", { kind: "quiet", block: true, onClick: async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try { const r = await syncNow(ctx); toast(r?.changed ? "Synced. Updates from your household are in." : "Up to date"); }
      catch (x) { toast(x.message || "Couldn’t sync"); }
      ctx.render();
    } }),
  ];
  const backup = await preSyncBackup();
  if (backup?.data) {
    kids.push(btn("Download this device’s old budget", { kind: "quiet", block: true, onClick: () => {
      const blob = new Blob([JSON.stringify(backup.data, null, 2)], { type: "application/json" });
      h("a", { href: URL.createObjectURL(blob), download: `toozbudgeting-before-sign-in-${new Date(backup.at).toISOString().slice(0, 10)}.json` }).click();
    } }));
  }
  kids.push(btn("Sign out", { kind: "danger", block: true, onClick: () => confirmDialog({
    title: "Sign out?",
    message: "This device stops syncing with your household. The budget stays on this device until you sign in again.",
    confirm: "Sign out",
    onConfirm: async () => { await signOut(); ctx.accountSignedOut(); },
  }) }));
  return kids;
}

function roleSelect(value, { allowOwner = true } = {}) {
  const sel = h("select", { class: "input" });
  for (const r of ["owner", "member", "viewer"]) {
    if (r === "owner" && !allowOwner) continue;
    sel.append(h("option", { value: r, text: `${ROLE_LABEL[r]}: ${ROLE_HINT[r]}` }));
  }
  sel.value = value;
  return sel;
}

export function openPeople(ctx) {
  let host = null;
  let justInvited = null; // shown with its share button at the top of the form after creating it
  openSheet({ title: "People", body: (el) => { host = el; } });
  const paint = async () => {
    host.replaceChildren(h("p", { class: "hint", text: "Loading…" }));
    let a; let data;
    try { a = (await refreshMe()) || (await account()); data = await listMembers(); }
    catch (e) { host.replaceChildren(h("p", { class: "error", text: e.message })); return; }
    const me = a.me;
    const owner = me.role === "owner";
    const kids = [];
    if (owner) {
      const name = textInput({ value: me.household?.name || "" });
      kids.push(field("Household name", name), btn("Save name", { kind: "quiet", block: true, onClick: async () => {
        try { await renameHousehold(name.value); toast("Saved"); } catch (e) { toast(e.message); }
      } }));
    }
    kids.push(h("h3", { class: "kicker", text: "In this household" }));
    for (const m of data.members || []) {
      const isMe = m.userId === me.user.id;
      const row = h("div", { class: "pair person" },
        h("div", { class: "who" }, avatar(m, 36), h("span", {},
          h("strong", { text: `${m.name}${isMe ? " (you)" : ""}` }),
          h("span", { class: "muted", text: `${m.email} · ${ROLE_LABEL[m.role]}${m.scopes ? " · limited" : ""}` }),
        )),
      );
      if (owner && !isMe) {
        const sel = roleSelect(m.role);
        sel.addEventListener("change", async () => {
          try { await setMember(m.userId, { role: sel.value }); toast(`${m.name} is now ${ROLE_LABEL[sel.value].toLowerCase()}`); }
          catch (e) { toast(e.message); }
          paint();
        });
        row.append(field("Role", sel), btn("Remove from household", { kind: "quiet", onClick: () => confirmDialog({
          title: `Remove ${m.name}?`,
          message: "They’re signed out everywhere and can’t see the budget anymore. You can invite them again later.",
          confirm: "Remove", danger: true,
          onConfirm: async () => { try { await removeMember(m.userId); } catch (e) { toast(e.message); } paint(); },
        }) }));
      }
      if (isMe) {
        row.append(btn("Change my name", { kind: "quiet", onClick: () => editName(me, paint) }));
      }
      kids.push(row);
    }
    if (owner) {
      if ((data.invites || []).length) {
        kids.push(h("h3", { class: "kicker", text: "Invited" }));
        for (const inv of data.invites) {
          kids.push(h("div", { class: "pair person invite-row" },
            h("span", { text: `${inv.email} · ${ROLE_LABEL[inv.role]} · until ${new Date(inv.expiresAt).toLocaleDateString()}` }),
            h("div", { class: "row-actions" },
              shareButton(inv, me.household?.name),
              btn("Cancel", { kind: "quiet", onClick: async () => { await revokeInvite(inv.id); paint(); } }),
            ),
          ));
        }
      }
      const email = textInput({ type: "email", placeholder: "their Google email", autocomplete: "off" });
      const sel = roleSelect("owner");
      const out = h("div", { class: "invite-out" });
      if (justInvited) {
        out.append(
          h("p", { class: "hint", text: `Invited ${justInvited.email}. Nothing is sent automatically, so share the link with them. They sign in with Google using that email. The invite lasts 14 days.` }),
          shareButton(justInvited, me.household?.name, { kind: "primary", block: true }),
        );
      }
      kids.push(
        h("h3", { class: "kicker", text: "Invite someone" }),
        field("Email", email),
        field("Role", sel),
        btn("Invite", { block: true, onClick: async (e) => {
          const b = e.currentTarget; b.disabled = true;
          try {
            const r = await invite(email.value, sel.value);
            justInvited = r.invite;
            await paint();
            return;
          } catch (x) { out.replaceChildren(h("p", { class: "error", text: x.message })); }
          b.disabled = false;
        } }),
        out,
      );
    } else {
      kids.push(h("p", { class: "hint", text: "A household owner can invite people and change roles." }));
    }
    host.replaceChildren(...kids);
  };
  paint();
}

function editName(me, after) {
  const input = textInput({ value: me.user.displayName || me.user.name || "" });
  const sheet = openSheet({ title: "Your name", body: (host) => {
    host.append(field("Name your household sees", input), btn("Save", { block: true, onClick: async () => {
      try { await setMyName(input.value); await refreshMe(); sheet.close(); after?.(); } catch (e) { toast(e.message); }
    } }));
  } });
}
