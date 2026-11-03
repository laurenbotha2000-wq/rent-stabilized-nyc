// Nearest subway stations and an estimated subway commute, computed in the
// browser from MTA station data (web/stations.json). Estimates only: exact
// trips come from the "Directions" link (Google Maps transit, no key needed).
/** Straight-line distance in miles. */
export function miles(a, b) {
  const R = 3958.8, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const WALK_MPH = 3;          // walking speed
const DETOUR = 1.25;         // streets aren't straight lines
const RIDE_MPH = 17;         // average subway speed including stops
const RIDE_DETOUR = 1.3;     // track vs straight line
const WAIT_MIN = 5;          // average wait for a train
const TRANSFER_MIN = 8;      // extra when no single line connects the stations
const MAX_WALK_MI = 1;       // stations considered at each end

let stations = [];

export async function loadStations() {
  if (stations.length) return stations;
  const { stations: rows } = await (await fetch("/stations.json")).json();
  return setStations(rows);
}

/** Use station rows ([name, lat, lng, routes], as in stations.json) directly, e.g. on the server. */
export function setStations(rows) {
  stations = rows.map(([name, lat, lng, routes]) => ({ name, lat, lng, routes }));
  nearbyCache.clear();
  commuteCache.clear();
  return stations;
}

export const stationsReady = () => stations.length > 0;

// display order for line pickers: numbered lines, then letters by trunk line
const LINE_ORDER = ["1", "2", "3", "4", "5", "6", "7", "A", "C", "E", "B", "D", "F", "M", "G", "J", "Z", "L", "N", "Q", "R", "W", "S", "SIR"];
export function allLines() {
  const have = new Set(stations.flatMap((s) => s.routes));
  return [...LINE_ORDER.filter((l) => have.has(l)), ...[...have].filter((l) => !LINE_ORDER.includes(l)).sort()];
}

const walkMin = (mi) => (mi * DETOUR / WALK_MPH) * 60;
// Results depend only on coordinates, and the same points are asked about on
// every filter change, so remember them.
const nearbyCache = new Map();
const commuteCache = new Map();
const key = (p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

/** Stations within walking distance of a point, nearest first. */
export function nearby(p, limit = 3, maxMi = MAX_WALK_MI) {
  if (p?.lat == null || !stations.length) return [];
  const k = `${key(p)}|${limit}|${maxMi}`;
  if (!nearbyCache.has(k)) {
    nearbyCache.set(k, stations
      .map((s) => ({ ...s, mi: miles(p, s) }))
      .filter((s) => s.mi <= maxMi)
      .sort((a, b) => a.mi - b.mi)
      .slice(0, limit)
      .map((s) => ({ ...s, walk: Math.round(walkMin(s.mi)) })));
  }
  return nearbyCache.get(k);
}

/** Nearest station (any distance), for display. */
export function nearest(p) {
  return nearby(p, 1, Infinity)[0] || null;
}

/**
 * Estimated door-to-door minutes by subway (or walking, if quicker).
 * { minutes, via: "walk" | "rough" | {from, to, lines, transfer} }, or null
 * when either point has no location. "rough" is a distance-only guess used
 * while station data is unavailable.
 */
export function commute(from, to) {
  if (from?.lat == null || to?.lat == null) return null;
  const k = `${key(from)}>${key(to)}`;
  if (!commuteCache.has(k)) commuteCache.set(k, stations.length ? bySubway(from, to) : rough(from, to));
  return commuteCache.get(k);
}

/** Without station data: transit averages ~10 mph door to door, plus ~10 min of walking and waiting. */
function rough(from, to) {
  const mi = miles(from, to) * RIDE_DETOUR;
  return { minutes: Math.round(Math.min(walkMin(mi / RIDE_DETOUR), 10 + (mi / 10) * 60)), via: "rough" };
}

function bySubway(from, to) {
  const direct = miles(from, to);
  let best = { minutes: walkMin(direct), via: "walk" };
  for (const a of nearby(from, 4)) {
    for (const b of nearby(to, 4)) {
      const shared = a.routes.filter((r) => b.routes.includes(r));
      const ride = (miles(a, b) * RIDE_DETOUR / RIDE_MPH) * 60;
      const total = walkMin(a.mi) + WAIT_MIN + ride + (shared.length ? 0 : TRANSFER_MIN) + walkMin(b.mi);
      if (total < best.minutes) best = { minutes: total, via: { from: a, to: b, lines: shared.length ? shared : a.routes, transfer: !shared.length } };
    }
  }
  return { ...best, minutes: Math.round(best.minutes) };
}

export function describe(c) {
  if (!c) return "";
  if (c.via === "walk") return `~${c.minutes} min walk`;
  if (c.via === "rough") return `~${c.minutes} min (rough estimate)`;
  const { from, to, lines, transfer } = c.via;
  return `~${c.minutes} min: ${lines.slice(0, 3).join("/")} from ${from.name} to ${to.name}${transfer ? " (with a transfer)" : ""}`;
}

export function directionsUrl(from, to) {
  const p = new URLSearchParams({ api: "1", origin: `${from.lat},${from.lng}`, destination: `${to.lat},${to.lng}`, travelmode: "transit" });
  return `https://www.google.com/maps/dir/?${p}`;
}
