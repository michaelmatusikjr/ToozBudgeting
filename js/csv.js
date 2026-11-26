/** CSV parse, date/amount detection, and column guessing. */

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const src = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function parseCSVDate(s) {
  s = (s || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

export function parseCSVAmount(s) {
  let t = String(s || "").trim();
  if (!t) return 0;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (t.startsWith("-")) { neg = true; t = t.slice(1); }
  t = t.replace(/[$,\s]/g, "");
  const v = parseFloat(t);
  if (isNaN(v)) return 0;
  return neg ? -Math.abs(v) : v;
}

export function guessColumnMapping(headers) {
  const norm = headers.map((h) => (h || "").trim().toLowerCase());
  const find = (...keywords) => {
    for (const kw of keywords) {
      const idx = norm.findIndex((h) => h === kw);
      if (idx >= 0) return headers[idx];
    }
    for (const kw of keywords) {
      const idx = norm.findIndex((h) => h.includes(kw));
      if (idx >= 0) return headers[idx];
    }
    return "";
  };
  const dateCol = find("date", "transaction date", "posted date", "posting date");
  const payeeCol = find("description", "payee", "merchant", "name", "memo", "details");
  const debitCol = find("debit", "withdrawal", "withdrawals");
  const creditCol = find("credit", "deposit", "deposits");
  const amountCol = find("amount", "amt");
  if (debitCol && creditCol) return { dateCol, payeeCol, amountMode: "split", debitCol, creditCol, amountCol: "", signConvention: "neg-expense" };
  return { dateCol, payeeCol, amountMode: "single", amountCol, signConvention: "neg-expense", debitCol: "", creditCol: "" };
}

export function applyMapping(row, headers, mapping) {
  const idx = (name) => headers.indexOf(name);
  const cell = (name) => (idx(name) >= 0 ? row[idx(name)] : "");
  const date = parseCSVDate(cell(mapping.dateCol));
  const payee = (cell(mapping.payeeCol) || "").trim();
  let amount = 0;
  if (mapping.amountMode === "split") {
    const debit = Math.abs(parseCSVAmount(cell(mapping.debitCol)));
    const credit = Math.abs(parseCSVAmount(cell(mapping.creditCol)));
    amount = debit > 0 ? debit : -credit;
  } else {
    const raw = parseCSVAmount(cell(mapping.amountCol));
    amount = mapping.signConvention === "pos-expense" ? raw : -raw;
  }
  return { date, payee, amount };
}
