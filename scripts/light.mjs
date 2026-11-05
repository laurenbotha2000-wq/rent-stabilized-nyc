// Estimate how much daylight each apartment gets, from free city data, and add it to the
// listings in data.json, in place:
//   light: { level: "bright"|"some"|"dim", score (0-100), floor, floor_known, why, as_of }
//
//   node light.mjs out/data.json [out/published.json]
//
// How: the apartment's floor comes from its unit number ("4B" → 4th floor, "PH" → top,
// "Garden" → ground). The heights and outlines of every building within 120 m come from
// the city's Building Footprints map (NYC Open Data 5zhs-2jue). Looking out from the
// apartment's floor in 16 directions, we find how high up the sky the tallest building in
// that direction reaches. Open sky counts most to the south (where the sun is in NYC),
// least to the north. It's an estimate: we don't know which way the windows face, how big
// they are, or about trees.
//
// A listing's unit and its surroundings rarely change, so estimates from the previously
// published file that are under 30 days old are reused.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const API = "https://data.cityofnewyork.us/resource/5zhs-2jue.json";
const MAX_AGE_MS = 30 * 86400_000;
const RADIUS_M = 120;
const BINS = 16;
const FT = 0.3048;

/**
 * Floor from the unit at the end of the listing link ("…/13-cumming-street-new_york/2g").
 * Returns { floor, known } or { top: true } for penthouses; null when the unit says nothing.
 */
export function floorOf(url) {
  const unit = decodeURIComponent(String(url || "").split(/[?#]/)[0].split("/").pop() || "").toLowerCase();
  if (!unit) return null;
  if (/^(ph|penthouse)/.test(unit)) return { top: true };
  if (/^(garden|grdn|gdn|basement|bsmt|ll|lower|ground|grd)/.test(unit) || unit === "g") return { floor: 1, known: true };
  if (/^parlou?r/.test(unit)) return { floor: 2, known: true };
  const th = unit.match(/(\d+)(st|nd|rd|th)-?fl/);
  if (th) return { floor: Number(th[1]), known: true };
  const m = unit.match(/(\d{1,4})/); // "4B", "B4", "N2F", "south-3g"
  if (!m) return null;
  const digits = m[1], n = Number(digits);
  if (!n) return { floor: 1, known: true }; // "0", "00"
  // "1203" → 12th, "405" → 4th; "4B" / "B4" / "4" → 4th
  if (digits.length >= 3) return { floor: Math.floor(n / 100), known: true };
  return { floor: n, known: true, loose: !/[a-z]/.test(unit) }; // a bare "12" might be apartment 12
}

const toRad = (d) => (d * Math.PI) / 180;
/** Metres east/north of (lat0, lng0). */
const local = (lat0, lng0) => ([lng, lat]) => [
  (lng - lng0) * 111_320 * Math.cos(toRad(lat0)),
  (lat - lat0) * 110_540,
];
const binOf = (x, y) => {
  const bearing = (Math.atan2(x, y) * 180) / Math.PI; // 0 = north, 90 = east
  return Math.round(((bearing + 360) % 360) / (360 / BINS)) % BINS;
};
// how much open sky in each direction is worth: south most (sun), north least
const WEIGHT = Array.from({ length: BINS }, (_, i) => 0.35 + 0.65 * (1 - Math.cos(toRad(i * (360 / BINS)))) / 2);
const DIRS = ["north", "north-northeast", "northeast", "east-northeast", "east", "east-southeast", "southeast",
  "south-southeast", "south", "south-southwest", "southwest", "west-southwest", "west", "west-northwest", "northwest", "north-northwest"];

function outlines(geom) {
  const polys = geom?.type === "MultiPolygon" ? geom.coordinates : geom?.type === "Polygon" ? [geom.coordinates] : [];
  return polys.map((p) => p[0] || []);
}

async function nearby(lat, lng) {
  const params = new URLSearchParams({
    $select: "height_roof,ground_elevation,base_bbl,the_geom",
    $where: `within_circle(the_geom, ${lat}, ${lng}, ${RADIUS_M})`,
    $limit: "2000",
  });
  const headers = process.env.SOCRATA_APP_TOKEN ? { "X-App-Token": process.env.SOCRATA_APP_TOKEN } : {};
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}?${params}`, { headers });
    if (res.ok) return res.json();
    if (attempt >= 3 || res.status < 500 && res.status !== 429) throw new Error(`footprints: HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

/** Distance from point p to segment a-c (metres). */
function segDist([px, py], [ax, ay], [cx, cy]) {
  const dx = cx - ax, dy = cy - ay, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/** Point-in-polygon on local metre coordinates. */
function inside([x, y], ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * The estimate for one apartment. `buildings` is the city's footprint rows around it.
 * Exported for tests.
 */
export function estimate(l, buildings) {
  const at = local(l.lat, l.lng);
  const rows = buildings.map((b) => ({
    bbl: String(b.base_bbl || ""),
    height: Number(b.height_roof) * FT || 0,
    ground: Number(b.ground_elevation) * FT || 0,
    rings: outlines(b.the_geom).map((r) => r.map(at)),
  })).filter((b) => b.rings.length);
  const bbl = String(l.geo_bbl || l.bbl || "");
  // the apartment's own building: the footprint it sits in, else the closest one on its tax lot
  let home = rows.find((b) => b.rings.some((r) => inside([0, 0], r)));
  if (!home) {
    const dist = (b) => Math.min(...b.rings.flat().map(([x, y]) => Math.hypot(x, y)));
    home = rows.filter((b) => b.bbl === bbl).sort((a, b) => dist(a) - dist(b))[0];
  }
  if (!home || !home.height) return null;

  const floors = Math.max(1, Math.round(home.height / 3.2));
  const f = floorOf(l.url);
  let floor = f?.top ? floors : f?.floor;
  const known = Boolean(f && (f.top || (f.known && floor <= floors)));
  if (!known || !floor) floor = Math.min(2, floors);
  floor = Math.min(floor, floors);
  const eye = home.ground + (floor - 1) * 3.2 + 1.5;

  // the apartment's own walls: how far its building reaches from the point in each direction
  const reach = new Array(BINS).fill(0);
  for (const r of home.rings) for (const [x, y] of r) { const k = binOf(x, y); reach[k] = Math.max(reach[k], Math.hypot(x, y)); }
  const mean = reach.filter(Boolean).reduce((s, v, _, a) => s + v / a.length, 0) || 8;
  for (let k = 0; k < BINS; k++) if (!reach[k]) reach[k] = mean;

  // buildings sharing a wall with this one: no windows face them, so leave those directions out
  const homeEdges = home.rings.flatMap((r) => r.map((p, i) => [p, r[(i + 1) % r.length]]));
  const touches = (b) => b.rings.some((r) => r.some((p) => homeEdges.some(([a, c]) => segDist(p, a, c) < 2.5)));
  const party = new Set();
  for (const b of rows) {
    if (b === home || !touches(b)) continue;
    b.attached = true;
    for (const r of b.rings) for (const [x, y] of r) if (homeEdges.some(([a, c]) => segDist([x, y], a, c) < 2.5)) party.add(binOf(x, y));
  }

  // highest angle of obstruction in each direction
  const angle = new Array(BINS).fill(0), blocker = new Array(BINS).fill(null);
  for (const b of rows) {
    if (b === home || b.attached) continue;
    const top = b.ground + b.height - eye;
    if (top <= 0) continue;
    for (const r of b.rings) for (const [x, y] of r) {
      const k = binOf(x, y);
      const d = Math.max(3, Math.hypot(x, y) - reach[k]);
      const a = (Math.atan2(top, d) * 180) / Math.PI;
      if (a > angle[k]) { angle[k] = a; blocker[k] = { d, h: b.height }; }
    }
  }
  // open sky per direction: full above ~10°, none once buildings fill 60° of it
  const open = angle.map((a) => 1 - Math.min(1, Math.max(0, a - 10) / 50));
  let ks = [...Array(BINS).keys()].filter((k) => !party.has(k));
  if (ks.length < 4) ks = [...Array(BINS).keys()];
  let score = ks.reduce((s, k) => s + open[k] * WEIGHT[k], 0) / ks.reduce((s, k) => s + WEIGHT[k], 0);
  if (floor === 1) score *= 0.85; // street level: parked trucks, trees, stoops, people looking in
  score = Math.round(score * 100);
  const level = score >= 70 ? "bright" : score >= 45 ? "some" : "dim";

  const why = [];
  const ord = (n) => `${n}${[, "st", "nd", "rd"][((n % 100) - 20) % 10] || [, "st", "nd", "rd"][n % 100] || "th"}`;
  why.push(known ? `${ord(floor)} floor of ${floors}` : `floor not listed (assumed ${ord(floor)} of ${floors})`);
  const southish = [6, 7, 8, 9, 10].filter((k) => ks.includes(k));
  const worstSouth = southish.reduce((w, k) => (w == null || angle[k] > angle[w] ? k : w), null);
  if (worstSouth == null) why.push("no windows likely to the south (shared walls)");
  else if (angle[worstSouth] > 20 && blocker[worstSouth]) {
    const bl = blocker[worstSouth];
    why.push(`a ${Math.round(bl.h / 3.2)}-story building ${Math.round(bl.d)} m to the ${DIRS[worstSouth]}`);
  } else why.push("open to the south");
  const blocked = ks.filter((k) => open[k] < 0.5).length;
  if (blocked >= ks.length / 2) why.push("tall buildings close on most sides");
  else if (blocked === 0) why.push("nothing tall close by");
  return { level, score, floor, floor_known: known, why: why.join("; "), as_of: new Date().toISOString() };
}

async function main() {
  const [file, previousFile] = process.argv.slice(2);
  if (!file) throw new Error("usage: node light.mjs data.json [published.json]");
  const data = JSON.parse(readFileSync(file, "utf8"));
  const cached = new Map();
  if (previousFile && existsSync(previousFile)) {
    for (const l of JSON.parse(readFileSync(previousFile, "utf8")).listings || []) {
      if (l.light?.as_of && Date.now() - Date.parse(l.light.as_of) < MAX_AGE_MS) cached.set(l.url, l.light);
    }
  }
  const todo = data.listings.filter((l) => l.lat != null && !cached.has(l.url));
  // apartments in the same building share one lookup
  const groups = new Map();
  for (const l of todo) {
    const k = `${l.lat.toFixed(5)},${l.lng.toFixed(5)}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(l);
  }
  const fresh = new Map();
  let failed = 0;
  const queue = [...groups.values()];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let g; (g = queue.shift());) {
      try {
        const rows = await nearby(g[0].lat, g[0].lng);
        for (const l of g) { const e = estimate(l, rows); if (e) fresh.set(l.url, e); }
      } catch (e) {
        failed += g.length;
        if (failed === g.length) console.log(`Light lookup failed (kept previous data): ${e.message}`);
      }
    }
  }));
  let attached = 0;
  for (const l of data.listings) {
    const e = fresh.get(l.url) || cached.get(l.url);
    if (e) { l.light = e; attached++; }
  }
  writeFileSync(file, JSON.stringify(data));
  console.log(`Light: ${cached.size} reused, ${fresh.size} estimated${failed ? `, ${failed} failed` : ""}; attached to ${attached} listings`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
