// Ledger Agent for Vercel. Question -> (LLM writes a JSON plan) -> (our code computes the exact answer).
// Environment variables to set on Vercel:  LEDGER_URL (the full URL from the question), AIPIPE_TOKEN
// Optional: MODEL (default gpt-5.4-mini), USE_PAGES=1 (load page by page instead of the export file)

const LLM_URL = "https://aipipe.org/openai/v1/chat/completions";
const IST_MS = 5.5 * 3600 * 1000; // business dates use Asia/Kolkata (UTC+5:30)
let CACHE = { data: null, at: 0 };

/* ---------- 1. LOAD + CLEAN THE DATA ---------- */
async function getJson(url) { return (await fetch(url)).json(); }

async function fetchRaw(env) {
  const root = await getJson(env.LEDGER_URL);
  const rates = (await getJson(root.links.rates)).usd_per_unit;
  let rows = [];
  if (env.USE_PAGES) {
    const first = await getJson(root.links.orders);
    rows = first.orders.slice();
    const rest = [];
    for (let p = 2; p <= first.pages; p++) rest.push(getJson(root.links.orders.replace(/page=\d+$/, "page=" + p)));
    for (const pg of await Promise.all(rest)) rows.push(...pg.orders);
  } else {
    const text = (await (await fetch(root.links.export)).text()).trim();
    rows = text.startsWith("[") ? JSON.parse(text) : text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  }
  return { rows, rates };
}

function clean(rows, rates) {
  const latest = new Map(); // keep, for every order id, the row with the newest updated_at (compared as real instants)
  for (const r of rows) {
    const t = Date.parse(r.updated_at);
    const old = latest.get(r.id);
    if (!old || t >= old.t) latest.set(r.id, { t, r });
  }
  return [...latest.values()].map(({ r }) => {
    const date = new Date(Date.parse(r.created_at) + IST_MS).toISOString().slice(0, 10); // India date
    const month = date.slice(0, 7);
    return {
      id: r.id, customer: r.customer, region: String(r.region).trim(), product: String(r.product).trim(),
      qty: Number(r.qty), unit_price: Number(r.unit_price), amount: Number(r.amount), currency: r.currency,
      status: String(r.status).trim().toLowerCase(),
      date, month, year: date.slice(0, 4), quarter: date.slice(0, 4) + "-Q" + (Math.floor((+month.slice(5) - 1) / 3) + 1),
      usd: Number(r.amount) * (rates[r.currency] ?? NaN),
    };
  });
}

async function loadData(env) {
  if (CACHE.data && Date.now() - CACHE.at < 600000) return CACHE.data;
  const { rows, rates } = await fetchRaw(env);
  const data = { rows: clean(rows, rates), rawCount: rows.length };
  const uniq = (k) => [...new Set(data.rows.map((r) => r[k]))].sort();
  data.values = { region: uniq("region"), product: uniq("product"), status: uniq("status"), currency: uniq("currency") };
  CACHE = { data, at: Date.now() };
  return data;
}

/* ---------- 2. THE EXACT CALCULATOR ---------- */
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const cmp = {
  eq: same, ne: (a, b) => !same(a, b),
  gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b,
  in: (a, b) => b.some((x) => same(a, x)),
  contains: (a, b) => String(a).toLowerCase().includes(String(b).toLowerCase()),
};
const cent = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

function calc(rows, plan) {
  const filters = [...(plan.filters || [])];
  if (plan.status && plan.status !== "all") filters.push({ field: "status", op: "eq", value: plan.status });
  const sel = rows.filter((r) => filters.every((f) => cmp[f.op] && cmp[f.op](r[f.field], f.value)));
  const run = (rs) => {
    const vals = rs.map((r) => Number(r[plan.field])).filter((v) => !Number.isNaN(v));
    const sum = vals.reduce((a, b) => a + b, 0);
    switch (plan.op) {
      case "count": return rs.length;
      case "sum": return cent(sum);
      case "avg": return vals.length ? cent(sum / vals.length) : 0;
      case "min": return vals.length ? cent(Math.min(...vals)) : null;
      case "max": return vals.length ? cent(Math.max(...vals)) : null;
      case "count_distinct": return new Set(rs.map((r) => r[plan.field])).size;
      case "list_distinct": return [...new Set(rs.map((r) => r[plan.field]))].sort();
      default: throw new Error("bad op " + plan.op);
    }
  };
  if (!plan.group_by) return run(sel);
  const groups = new Map();
  for (const r of sel) { if (!groups.has(r[plan.group_by])) groups.set(r[plan.group_by], []); groups.get(r[plan.group_by]).push(r); }
  let out = [...groups].map(([k, rs]) => [k, run(rs)]);
  if (plan.order) out.sort((a, b) => (plan.order === "desc" ? b[1] - a[1] : a[1] - b[1]));
  if (plan.limit) out = out.slice(0, plan.limit);
  return plan.limit === 1 ? (out[0] ? out[0][0] : null) : Object.fromEntries(out);
}

/* ---------- 3. THE LLM ONLY TRANSLATES ENGLISH -> PLAN ---------- */
function promptFor(question, values) {
  return `You convert questions about an order ledger into a JSON query plan. Reply with JSON only.

Each row is one order (already de-duplicated). Columns:
id, customer, region, product, qty, unit_price, amount, currency, status,
date (YYYY-MM-DD, India time), month ("2026-03"), quarter ("2026-Q1"), year ("2026"),
usd (the order amount converted to US dollars).
Exact values that exist -> region: ${JSON.stringify(values.region)}; product: ${JSON.stringify(values.product)};
status: ${JSON.stringify(values.status)}; currency: ${JSON.stringify(values.currency)}.
Always use these exact spellings in filter values.

Plan format:
{"op":"sum|count|avg|min|max|count_distinct|list_distinct","field":"<column>","status":"paid|refunded|void|all",
 "filters":[{"field":"<column>","op":"eq|ne|gt|gte|lt|lte|in|contains","value":<v>}],
 "group_by":null or "<column>","order":null or "asc|desc","limit":null or <number>}

Rules:
- Revenue / sales / income / money earned: op sum, field usd, status paid.
- Refund amounts / money refunded: op sum, field usd, status refunded. Number of refunds: op count, status refunded.
- Number of orders: op count, status paid (unless the question asks about refunded, void or all orders).
- Units sold: op sum, field qty, status paid. Average order value: op avg, field usd, status paid.
- Number of customers: op count_distinct, field customer, status paid unless told otherwise.
- A month is {"field":"month","op":"eq","value":"2026-03"}; a quarter uses the quarter column; a date range uses date gte / lt.
- "Which X had the most/least ...": group_by X, order desc/asc, limit 1. "Top 3 X": limit 3.

Examples:
Q: Total revenue in USD from the north region in March 2026
A: {"op":"sum","field":"usd","status":"paid","filters":[{"field":"region","op":"eq","value":"North"},{"field":"month","op":"eq","value":"2026-03"}],"group_by":null,"order":null,"limit":null}
Q: Which product earned the most revenue in Q1 2026?
A: {"op":"sum","field":"usd","status":"paid","filters":[{"field":"quarter","op":"eq","value":"2026-Q1"}],"group_by":"product","order":"desc","limit":1}
Q: How many distinct customers bought a Kettle in April 2026?
A: {"op":"count_distinct","field":"customer","status":"paid","filters":[{"field":"product","op":"eq","value":"Kettle"},{"field":"month","op":"eq","value":"2026-04"}],"group_by":null,"order":null,"limit":null}
Q: How much was refunded in the West region in total?
A: {"op":"sum","field":"usd","status":"refunded","filters":[{"field":"region","op":"eq","value":"West"}],"group_by":null,"order":null,"limit":null}

Q: ${question}
A:`;
}

async function makePlan(question, values, env) {
  const res = await fetch(LLM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.AIPIPE_TOKEN}` },
    body: JSON.stringify({
      model: env.MODEL || "gpt-5.4-mini",
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: promptFor(question, values) }],
    }),
  });
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

/* ---------- 4. THE WEB ENDPOINT ---------- */
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    const data = await loadData(process.env);
    if (req.method !== "POST") { // handy health check: open the URL in a browser
      const counts = {};
      for (const r of data.rows) counts[r.status] = (counts[r.status] || 0) + 1;
      return res.status(200).json({ ok: true, totalRows: data.rawCount, uniqueOrders: data.rows.length, statusCounts: counts, values: data.values });
    }
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) { // one retry if the LLM returns something unusable
      try {
        const plan = await makePlan(String(body.question || ""), data.values, process.env);
        return res.status(200).json({ answer: calc(data.rows, plan) });
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  } catch (e) {
    return res.status(500).json({ answer: null, error: String(e) });
  }
};
module.exports._calc = calc; module.exports._clean = clean;
