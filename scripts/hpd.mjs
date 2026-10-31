// Add each building's NYC HPD record to the listings in data.json, in place:
//   hpd: { violations: {A, B, C, total} (open), complaints_12mo, owner, agent, registered, as_of }
//
//   node hpd.mjs out/data.json [out/published.json]
//
// Sources (NYC Open Data, free; SOCRATA_APP_TOKEN raises rate limits if set):
//   HPD Violations wvxf-dwi5, HPD Complaints ygpa-z7cr,
//   HPD Registrations tesw-yqqr and Registration Contacts feu5-w2e2.
// Building records change slowly: entries from the previously published file
// that are under a day old are reused instead of asking the city again.
// Individual owners' names are not published; companies and agents are.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const API = "https://data.cityofnewyork.us/resource";
const MAX_AGE_MS = 24 * 3600_000;
const BATCH = 40;
const [file, previousFile] = process.argv.slice(2);
if (!file) throw new Error("usage: node hpd.mjs data.json [published.json]");

const data = JSON.parse(readFileSync(file, "utf8"));
const bblOf = (l) => l.geo_bbl || l.bbl || null;

// reuse fresh records from the last published copy
const cached = new Map();
if (previousFile && existsSync(previousFile)) {
  for (const l of JSON.parse(readFileSync(previousFile, "utf8")).listings || []) {
    const b = bblOf(l);
    if (b && l.hpd?.as_of && Date.now() - Date.parse(l.hpd.as_of) < MAX_AGE_MS) cached.set(b, l.hpd);
  }
}

const wanted = [...new Set(data.listings.map(bblOf).filter((b) => b && /^\d{10}$/.test(b)))];
const todo = wanted.filter((b) => !cached.has(b));
const parts = (bbl) => ({ boro: bbl[0], block: String(Number(bbl.slice(1, 6))), lot: String(Number(bbl.slice(6))) });
const key = (boro, block, lot) => `${boro}${String(block).padStart(5, "0")}${String(lot).padStart(4, "0")}`;

async function soql(dataset, params) {
  const url = `${API}/${dataset}.json?${new URLSearchParams({ $limit: "50000", ...params })}`;
  const headers = process.env.SOCRATA_APP_TOKEN ? { "X-App-Token": process.env.SOCRATA_APP_TOKEN } : {};
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers });
    if (res.ok) return res.json();
    if (attempt >= 3 || res.status < 500 && res.status !== 429) throw new Error(`${dataset}: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); // back off and retry
  }
}

const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const lotsWhere = (bbls) => bbls.map((b) => {
  const p = parts(b);
  return `(boroid=${quote(p.boro)} AND block=${quote(p.block)} AND lot=${quote(p.lot)})`;
}).join(" OR ");

const fresh = new Map();
const since = new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
let failed = 0;
for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  try {
    const [violations, complaints, registrations] = await Promise.all([
      soql("wvxf-dwi5", {
        $select: "boroid,block,lot,class,count(*) as n",
        $where: `violationstatus='Open' AND (${lotsWhere(batch)})`,
        $group: "boroid,block,lot,class",
      }),
      soql("ygpa-z7cr", {
        $select: "bbl,count(*) as n",
        $where: `received_date > ${quote(since)} AND bbl in(${batch.map(quote).join(",")})`,
        $group: "bbl",
      }),
      soql("tesw-yqqr", {
        $select: "boroid,block,lot,registrationid,lastregistrationdate",
        $where: lotsWhere(batch),
      }),
    ]);
    const latestReg = new Map();
    for (const r of registrations) {
      const k = key(r.boroid, r.block, r.lot);
      if (!latestReg.has(k) || (r.lastregistrationdate || "") > (latestReg.get(k).lastregistrationdate || "")) latestReg.set(k, r);
    }
    const regIds = [...new Set([...latestReg.values()].map((r) => r.registrationid))];
    const contacts = regIds.length ? await soql("feu5-w2e2", {
      $select: "registrationid,type,corporationname",
      $where: `registrationid in(${regIds.map(quote).join(",")}) AND type in('CorporateOwner','IndividualOwner','JointOwner','Agent')`,
    }) : [];
    const byReg = new Map();
    for (const c of contacts) (byReg.get(c.registrationid) || byReg.set(c.registrationid, []).get(c.registrationid)).push(c);

    for (const b of batch) {
      const v = { A: 0, B: 0, C: 0, total: 0 };
      for (const r of violations) {
        if (key(r.boroid, r.block, r.lot) !== b) continue;
        const n = Number(r.n) || 0;
        if (r.class in v) v[r.class] += n;
        v.total += n;
      }
      const reg = latestReg.get(b);
      const cs = reg ? byReg.get(reg.registrationid) || [] : [];
      const corp = cs.find((c) => c.type === "CorporateOwner" && c.corporationname)?.corporationname;
      const person = cs.some((c) => c.type === "IndividualOwner" || c.type === "JointOwner");
      fresh.set(b, {
        violations: v,
        complaints_12mo: Number(complaints.find((c) => c.bbl === b)?.n || 0),
        owner: corp || (person ? "Individual owner" : null),
        agent: cs.find((c) => c.type === "Agent" && c.corporationname)?.corporationname || null,
        registered: Boolean(reg),
        as_of: new Date().toISOString(),
      });
    }
  } catch (e) {
    failed += batch.length;
    console.log(`HPD lookup failed for ${batch.length} buildings (kept previous data): ${e.message}`);
  }
}

let attached = 0;
for (const l of data.listings) {
  const rec = fresh.get(bblOf(l)) || cached.get(bblOf(l));
  if (rec) { l.hpd = rec; attached++; }
}
writeFileSync(file, JSON.stringify(data));
console.log(`HPD: ${wanted.length} buildings (${cached.size} reused, ${fresh.size} looked up${failed ? `, ${failed} failed` : ""}); attached to ${attached} listings`);
