// Which listings a set of filters (or a saved search) matches. Shared by the
// site and the alert sender (scripts/notify.mjs), so alerts fire for exactly
// what the saved search shows on the site.
import { commute, nearby, stationsReady } from "./commute.js";

export const asList = (v) => (v === undefined || v === "" ? [] : Array.isArray(v) ? v : [v]);

const KEYS = ["hoods", "beds", "min", "max", "reason", "features", "commute", "walk", "lines", "delisted", "unflagged", "noHazard", "prewar", "days"];
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
  if (f.days && !(l.first_seen && Date.now() - new Date(l.first_seen).getTime() <= f.days * DAY)) return false;
  // subway filters need station data; until it loads they don't exclude anything
  if ((f.walk || f.lines) && stationsReady()) {
    if (l.lat == null) return false;
    const reach = nearby(l, 8, walkMiles(f.walk || 15));
    if (!reach.length) return false;
    if (f.lines && !reach.some((s) => s.routes.some((r) => f.lines.includes(r)))) return false;
  }
  if (f.commute) {
    const c = commuteFor(l, f.commute);
    if (!c || c.minutes > f.commute.minutes) return false;
  }
  return true;
}
