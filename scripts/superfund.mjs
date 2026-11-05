// Mark listings within 500 m of an active federal Superfund site in NYC, in place:
//   superfund: { name, m }   (m = metres to the site's boundary; 0 = inside it)
//
//   node superfund.mjs out/data.json
//
// Boundaries: web/superfund.json, the U.S. EPA's official site boundaries for the four
// NYC sites on the National Priorities List (Gowanus Canal, Newtown Creek, Meeker Avenue
// Plume, Wolff-Alport Chemical Company), simplified to about 3 m. No network needed.
import { readFileSync, writeFileSync } from "node:fs";

const NEAR_M = 500;

export function loadSites(path = new URL("../web/superfund.json", import.meta.url)) {
  return JSON.parse(readFileSync(path, "utf8")).features.map((f) => ({
    name: f.properties.name,
    polys: f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates,
  }));
}

/** { name, m } for the closest site within NEAR_M metres of (lat, lng), else null. */
export function nearestSite(sites, lat, lng) {
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180), ky = 110_540;
  const xy = ([x, y]) => [(x - lng) * kx, (y - lat) * ky];
  let best = null;
  for (const s of sites) {
    for (const poly of s.polys) {
      let inside = false, d = Infinity;
      for (const ring of poly) {
        const pts = ring.map(xy);
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [ax, ay] = pts[j], [bx, by] = pts[i];
          if ((by > 0) !== (ay > 0) && 0 < ((ax - bx) * (0 - by)) / (ay - by) + bx) inside = !inside;
          const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
          const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
          d = Math.min(d, Math.hypot(ax + t * dx, ay + t * dy));
        }
      }
      const m = inside ? 0 : Math.round(d);
      if (m <= NEAR_M && (!best || m < best.m)) best = { name: s.name, m };
    }
  }
  return best;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) throw new Error("usage: node superfund.mjs data.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  const sites = loadSites();
  let near = 0;
  for (const l of data.listings) {
    delete l.superfund;
    if (l.lat == null) continue;
    const s = nearestSite(sites, l.lat, l.lng);
    if (s) { l.superfund = s; near++; }
  }
  writeFileSync(file, JSON.stringify(data));
  console.log(`Superfund: ${near} listings within ${NEAR_M} m of a site`);
}
