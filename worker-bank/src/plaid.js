/** Minimal Plaid client. Keys come from Worker secrets and are only ever sent to Plaid. */

const HOSTS = {
  production: "https://production.plaid.com",
  sandbox: "https://sandbox.plaid.com",
};

export class PlaidError extends Error {
  constructor(status, body) {
    super(body?.error_message || `Plaid HTTP ${status}`);
    this.status = status;
    this.code = body?.error_code || "UNKNOWN";
    this.type = body?.error_type || "";
    this.requestId = body?.request_id || "";
  }
}

export function plaidClient(env, fetchImpl = fetch) {
  const host = HOSTS[env.PLAID_ENV || "production"];
  if (!host) throw new Error("PLAID_ENV must be production or sandbox");
  return async function call(path, body = {}) {
    if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) throw new PlaidError(500, { error_code: "MISSING_KEYS", error_message: "Plaid keys are not set on the Worker" });
    const res = await fetchImpl(host + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Plaid-Version": "2020-09-14" },
      body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body }),
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) throw new PlaidError(res.status, data);
    return data;
  };
}

/** Item-level error codes that mean the bank login needs the user. */
export const LOGIN_CODES = new Set(["ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION", "PENDING_DISCONNECT", "INVALID_CREDENTIALS", "INVALID_MFA", "ITEM_LOCKED", "USER_SETUP_REQUIRED", "ACCESS_NOT_GRANTED", "INSUFFICIENT_CREDENTIALS"]);

/** Keep only the fields the app needs, so the inbox stays small. */
export function slimTx(t) {
  return {
    transaction_id: t.transaction_id,
    account_id: t.account_id,
    amount: t.amount,
    iso_currency_code: t.iso_currency_code || null,
    date: t.date,
    authorized_date: t.authorized_date || null,
    name: t.name || "",
    merchant_name: t.merchant_name || null,
    pending: !!t.pending,
    pending_transaction_id: t.pending_transaction_id || null,
    payment_channel: t.payment_channel || null,
    pfc: t.personal_finance_category ? { primary: t.personal_finance_category.primary, detailed: t.personal_finance_category.detailed } : null,
  };
}

export function slimAccount(a) {
  return {
    account_id: a.account_id,
    name: a.name || "",
    official_name: a.official_name || null,
    mask: a.mask || null,
    type: a.type || null,
    subtype: a.subtype || null,
    balances: a.balances ? { current: a.balances.current ?? null, available: a.balances.available ?? null, iso_currency_code: a.balances.iso_currency_code || null } : null,
  };
}
