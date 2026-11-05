// Which listings a set of filters (or a saved search) matches. Shared by the
// site and the alert sender (scripts/notify.mjs), so alerts fire for exactly
// what the saved search shows on the site.
import { commute, nearby, stationsReady } from "./commute.js";

export const asList = (v) => (v === undefined || v === "" ? [] : Array.isArray(v) ? v : [v]);

const KEYS = ["hoods", "beds", "min", "max", "reason", "features", "commute", "commute2", "walk", "lines", "delisted", "unflagged", "noHazard", "prewar", "days", "grade", "income", "light", "superfund"];
/** A saved search's filters in today's shape. */
export function normalize(f) {
  const o = {};
  for (const k of KEYS) if (f?.[k] !== undefined) o[k] = f[k];
  for (const k of ["beds", "reason"]) if (o[k] !== undefined) o[k] = asList(o[k]); // older saves held one value
  return o;
}

// NYC listings call buildings from before 1940 "prewar"; PLUTO's year is often an estimate.
const PREWAR_BEFORE = 1940;
const DAY = 86400_000;
/**
 * Building grade from open HPD violations, per apartment (A best … F worst).
 * Based on the city's own yardsticks for "serious" (class B hazardous + class C immediately
 * hazardous) violations per apartment:
 *   F  at the Public Advocate's Worst Landlord Watchlist level: 3+ per apartment
 *      (2+ in buildings of 35 or more apartments). HPD's Alternative Enforcement
 *      Program starts at 3–5 per apartment.
 *   D  1.5 or more · C  0.75 or more · B  0.25 or more · A  under 0.25 (fewer than one per four apartments)
 * Immediately hazardous (class C) problems cap the grade: 1 per 20 apartments → at best B,
 * 1 per 4 apartments → at best C. Unknown apartment count → no grade.
 */
export const GRADES = ["A", "B", "C", "D", "F"];
export function grade(l) {
  const h = l.hpd;
  if (!h?.units) return null;
  const { B, C } = h.violations;
  const perUnit = (B + C) / h.units, cPerUnit = C / h.units;
  let letter = perUnit >= (h.units >= 35 ? 2 : 3) ? "F" : perUnit >= 1.5 ? "D" : perUnit >= 0.75 ? "C" : perUnit >= 0.25 ? "B" : "A";
  if (letter === "A" && cPerUnit >= 0.05) letter = "B";
  if ((letter === "A" || letter === "B") && cPerUnit >= 0.25) letter = "C";
  return { letter, perUnit, serious: B + C, C, units: h.units };
}
/** For sorting best first: grade, then serious violations per apartment; ungraded last. */
export const gradeRank = (l) => { const g = grade(l); return g ? [GRADES.indexOf(g.letter), g.perUnit] : [9, Infinity]; };
export const isPrewar = (l) => l.hpd?.year_built != null && l.hpd.year_built < PREWAR_BEFORE;

/** Miles someone covers walking for `minutes` (same pace as the commute estimates). */
const walkMiles = (minutes) => (minutes / 60) * 3 / 1.25;
export const commuteFor = (l, to) => (l.lat == null ? null : commute(l, to));

export function matches(l, f) {
  if (!f.delisted && l.status !== "ACTIVE") return false;
  if (!f.unflagged && !l.reasons.length) return false;
  if (f.hoods && !f.hoods.includes(l.neighborhood)) return false;
  // bedrooms and reasons: any of the picked values; amenities: all of them
  if (f.beds && !(l.beds != null && f.beds.some((b) => (Number(b) === 4 ? l.beds >= 4 : l.beds === Number(b))))) return false;
  if (f.min !== undefined && !(l.price >= f.min)) return false;
  if (f.max !== undefined && !(l.price <= f.max)) return false;
  if (f.reason && !f.reason.some((r) => l.reasons.includes(r))) return false;
  if (f.features && !f.features.every((x) => (l.features || []).includes(x))) return false;
  if (f.noHazard && (!l.hpd || l.hpd.violations.C > 0)) return false;
  if (f.prewar && !isPrewar(l)) return false;
  if (f.grade) { const g = grade(l); if (!g || GRADES.indexOf(g.letter) > GRADES.indexOf(f.grade)) return false; }
  if (f.income === "exclude" && l.income_restricted) return false;
  if (f.income === "only" && !l.income_restricted) return false;
  if (f.light === "bright" && l.light?.level !== "bright") return false;
  if (f.light === "some" && !["bright", "some"].includes(l.light?.level)) return false;
  if (f.superfund === "exclude" && l.superfund) return false;
  if (f.days && !(l.first_seen && Date.now() - new Date(l.first_seen).getTime() <= f.days * DAY)) return false;
  // subway filters need station data; until it loads they don't exclude anything
  if ((f.walk || f.lines) && stationsReady()) {
    if (l.lat == null) return false;
    const reach = nearby(l, 8, walkMiles(f.walk || 15));
    if (!reach.length) return false;
    if (f.lines && !reach.some((s) => s.routes.some((r) => f.lines.includes(r)))) return false;
  }
  if (f.commute2) {
    const c = commuteFor(l, f.commute2);
    if (!c || c.minutes > f.commute2.minutes) return false;
  }
  if (f.commute) {
    const c = commuteFor(l, f.commute);
    if (!c || c.minutes > f.commute.minutes) return false;
  }
  return true;
}
