// Personal preferences: how well each listing matches.
import { category } from "./map.js";
import { commute, miles } from "./commute.js";

export { miles };

export const FEATURES = {
  dishwasher: "Dishwasher",
  laundry_unit: "Laundry in unit",
  laundry_building: "Laundry in building",
  pets: "Pet friendly",
  elevator: "Elevator",
  doorman: "Doorman",
  private_outdoor: "Private outdoor space",
  roof_deck: "Roof deck",
  gym: "Gym",
  no_fee: "No broker fee",
};

const STRENGTH = { likely: 1, text: 0.85, building: 0.7, none: 0.2 };

export const hasPrefs = (p) => !!p && Boolean(
  p.maxPrice || p.beds?.length || p.hoods?.length || p.near || p.must?.length || p.nice?.length || p.confidence === "likely");

const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
/** "1 CENTRE STREET, Manhattan, NY, USA" -> "1 Centre Street" */
export const placeName = (near) => (near?.label || "your place").split(",")[0]
  .toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const bedsOk = (l, beds) => l.beds != null && beds.some((b) => (Number(b) === 4 ? l.beds >= 4 : l.beds === Number(b)));

/**
 * { score: 0..100, ok: meets every must-have, why: short reasons, best first }
 */
export function match(l, p) {
  let total = 0, got = 0, ok = true;
  const good = [], bad = [];
  const add = (weight, s) => { total += weight; got += weight * Math.max(0, Math.min(1, s)); };
  const feats = l.features || [];

  if (p.maxPrice) {
    if (l.price == null) { add(3, 0); ok = false; bad.push("no price listed"); }
    else {
      const over = l.price - p.maxPrice;
      if (over <= 0) { add(3, 1); good.push(over <= -100 ? `${money(-over)} under budget` : "in budget"); }
      else { add(3, 1 - (over / p.maxPrice) * 5); ok = false; bad.push(`${money(over)} over budget`); }
    }
  }
  if (p.beds?.length) {
    const y = bedsOk(l, p.beds);
    add(2, y ? 1 : 0);
    if (!y) { ok = false; bad.push(l.beds === 0 ? "studio" : `${l.beds ?? "?"} bd`); }
  }
  if (p.hoods?.length) {
    const y = p.hoods.includes(l.neighborhood);
    add(2, y ? 1 : 0);
    if (y) good.push(l.neighborhood); else { ok = false; bad.push("other neighborhood"); }
  }
  if (p.near) {
    const c = l.lat == null ? null : commute(l, p.near);
    if (!c) { add(3, 0); ok = false; bad.push("location unknown"); }
    else {
      const max = p.near.minutes ?? 30;
      add(3, c.minutes <= max ? 1 - 0.4 * (c.minutes / max) : 0.5 - ((c.minutes - max) / max) * 0.5);
      const label = `~${c.minutes} min to ${placeName(p.near)}`;
      if (c.minutes <= max) good.push(label); else { ok = false; bad.push(label); }
    }
  }
  if (p.must?.length) {
    const have = p.must.filter((f) => feats.includes(f));
    add(3, have.length / p.must.length);
    for (const f of have) good.push(FEATURES[f].toLowerCase());
    const missing = p.must.filter((f) => !feats.includes(f));
    if (missing.length) { ok = false; bad.push(`no ${FEATURES[missing[0]].toLowerCase()} mentioned`); }
  }
  if (p.nice?.length) {
    const have = p.nice.filter((f) => feats.includes(f));
    add(1.5, have.length / p.nice.length);
    for (const f of have) good.push(FEATURES[f].toLowerCase());
  }
  const cat = category(l);
  add(2, STRENGTH[cat]);
  if (p.confidence === "likely" && !(cat === "likely" || cat === "text")) { ok = false; bad.push("less certain it's stabilized"); }
  if (cat === "likely") good.unshift("very likely stabilized");

  return { score: Math.round((got / total) * 100), ok, why: [...good.slice(0, 4), ...bad.slice(0, 2)] };
}

/** Look up an NYC address with NYC Planning's free geocoder. */
export async function geocode(text) {
  const url = `https://geosearch.planninglabs.nyc/v2/search?size=1&text=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`lookup failed (${res.status})`);
  const f = (await res.json()).features?.[0];
  if (!f) return null;
  const [lng, lat] = f.geometry.coordinates;
  return { lat, lng, label: f.properties.label || text };
}
