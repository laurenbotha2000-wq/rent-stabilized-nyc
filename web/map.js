// Map with clustered listing markers. Google Maps when an API key is
// configured; otherwise MapLibre with free OpenFreeMap tiles (no key).
// Units in the same building share one marker showing how many there are.
//   const map = await createMap(el, { googleKey, googleMapId, onSelect, onSelectBuilding, onMove });
//   map.setListings(listings);  map.focus(listing);  map.setTheme();  map.setGrouping(mode);
//   map.setNeighborhoods(on)  — NYC neighborhood outlines (2020 NTAs, NYC Open Data), loaded on first use
// onMove(bounds) fires after the person pans or zooms: { west, south, east, north }.

const NYC = { lat: 40.7128, lng: -73.97 };
const MAPLIBRE = "https://unpkg.com/maplibre-gl@4.7.1/dist";
const CLUSTERER = "https://unpkg.com/@googlemaps/markerclusterer@2.5.3/dist/index.min.js";

/** Marker category, strongest signal first. */
export function category(l) {
  const r = l.reasons || [];
  if (r.includes("IN_CITY_PDFS") && r.includes("UNEVEN_PRICE")) return "likely";
  if (r.includes("IN_CITY_PDFS")) return "building";
  if (r.includes("RENT_STABILIZED_TEXT_IN_LISTING")) return "text";
  return "none";
}

const RANK = { likely: 0, building: 1, text: 2, none: 3 };
const CLUSTER_MAX_ZOOM = 9; // group dots only when zoomed out past the whole city

/** Same building: tax lot when known, else the exact spot. */
export function buildingKey(l) {
  return l.geo_bbl || l.bbl || `${l.lat?.toFixed(5)},${l.lng?.toFixed(5)}`;
}

/** Mapped listings grouped by building: [{ lat, lng, units: [listing], cat }] */
function buildings(list) {
  const groups = new Map();
  for (const l of list) {
    if (l.lat == null || l.lng == null) continue;
    const k = buildingKey(l);
    (groups.get(k) || groups.set(k, []).get(k)).push(l);
  }
  return [...groups.values()].map((units) => ({
    lat: units.reduce((a, l) => a + l.lat, 0) / units.length,
    lng: units.reduce((a, l) => a + l.lng, 0) / units.length,
    units,
    cat: units.map(category).sort((a, b) => RANK[a] - RANK[b])[0],
  }));
}

/**
 * Dots for the chosen setting (nothing is ever clustered):
 *   "separate" — one per apartment; units in the same building fan out in a small ring
 *   "building" — one per building, numbered when it has several apartments
 */
/**
 * Map dots. "separate" fans a building's apartments out around it in a sunflower
 * pattern measured in screen pixels (`degPerPx` = degrees of longitude per pixel at
 * the current zoom), so the dots never pile on top of each other at any zoom.
 */
const SPACING_PX = 10; // dot radius 7 + ring, with a little air between dots
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
function dots(list, mode, degPerPx) {
  const bs = buildings(list);
  if (mode !== "separate" || !degPerPx) return bs;
  return bs.flatMap((b) => {
    const n = b.units.length;
    if (n === 1) return [b];
    const k = Math.cos((b.lat * Math.PI) / 180);
    return b.units.map((l, i) => {
      const r = SPACING_PX * Math.sqrt(i + 0.6) * degPerPx;
      const a = i * GOLDEN;
      return { lat: b.lat + r * k * Math.sin(a), lng: b.lng + r * Math.cos(a), units: [l], cat: category(l) };
    });
  });
}
export const GROUPINGS = ["building", "separate"];

const HOODS_URL = "/neighborhoods.json";
let hoodsData;
const loadHoods = () => (hoodsData ??= fetch(HOODS_URL).then((r) => {
  if (!r.ok) throw new Error(`Couldn't load neighborhoods (${r.status})`);
  return r.json();
}));

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
const dark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement("script"), { src, async: true });
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Couldn't load ${src}`));
    document.head.append(s);
  });
}

export async function createMap(el, opts) {
  return opts.googleKey ? googleMap(el, opts) : maplibreMap(el, opts);
}

// ---- Google Maps --------------------------------------------------------

async function googleMap(el, { googleKey, googleMapId, onSelect, onSelectBuilding, onMove, grouping = "separate" }) {
  const clustered = false;
  await new Promise((resolve, reject) => {
    window.__gmReady = resolve;
    const p = new URLSearchParams({ key: googleKey, v: "weekly", libraries: "marker", loading: "async", callback: "__gmReady" });
    loadScript(`https://maps.googleapis.com/maps/api/js?${p}`).catch(reject);
  });
  await loadScript(CLUSTERER);
  const { Map } = await google.maps.importLibrary("maps");
  const { AdvancedMarkerElement, PinElement } = await google.maps.importLibrary("marker");
  const map = new Map(el, {
    center: NYC, zoom: 11, mapId: googleMapId || "DEMO_MAP_ID",
    colorScheme: dark() ? "DARK" : "LIGHT", streetViewControl: false, mapTypeControl: false, clickableIcons: false,
    rotateControl: true,
  });
  map.addListener("idle", () => {
    const b = map.getBounds();
    if (b && el.clientWidth) {
      const ne = b.getNorthEast(), sw = b.getSouthWest();
      onMove?.({ west: sw.lng(), south: sw.lat(), east: ne.lng(), north: ne.lat() });
    }
  });
  const clusterer = new markerClusterer.MarkerClusterer({ map, markers: [],
    algorithm: new markerClusterer.SuperClusterAlgorithm({ maxZoom: CLUSTER_MAX_ZOOM, radius: 50 }) });
  let last = [], plain = [], zoomNow = map.getZoom();
  // apartment spacing is in pixels, so redraw when the zoom level changes
  map.addListener("zoom_changed", () => {
    if (map.getZoom() === zoomNow) return;
    zoomNow = map.getZoom();
    if (grouping === "separate" && last.length) api.setListings(last);
  });

  const api = {
    setListings(list) {
      last = list;
      clusterer.clearMarkers();
      for (const m of plain) m.map = null;
      plain = [];
      const made = [];
      for (const b of dots(list, grouping, 360 / (256 * 2 ** (map.getZoom() ?? 11)))) {
        const n = b.units.length;
        const pin = new PinElement({ background: css(b.cat), borderColor: "#ffffff", glyphColor: "#1b1713",
          glyph: n > 1 ? String(n) : undefined, scale: n > 1 ? 1.1 : 0.9 });
        const m = new AdvancedMarkerElement({ position: { lat: b.lat, lng: b.lng }, content: pin.element,
          title: n > 1 ? `${n} apartments at ${b.units[0].address || "this building"}` : b.units[0].address || "" });
        m.addListener("click", () => (n > 1 ? onSelectBuilding(b.units.map((l) => l.url)) : onSelect(b.units[0].url)));
        made.push(m);
      }
      if (clustered) clusterer.addMarkers(made);
      else { for (const m of made) m.map = map; plain = made; }
    },
    setTheme() { this.setListings(last); },
    setGrouping(mode) { grouping = mode; this.setListings(last); },
    async setNeighborhoods(on) {
      map.data.forEach((f) => map.data.remove(f));
      if (!on) return;
      map.data.addGeoJson(await loadHoods());
      map.data.setStyle({ fillOpacity: 0, strokeColor: css("ink"), strokeOpacity: 0.45, strokeWeight: 1, clickable: false });
    },
    focus(l) {
      if (l?.lat == null) return;
      map.panTo({ lat: l.lat, lng: l.lng });
      if (map.getZoom() < 15) map.setZoom(15);
    },
    fit(list) {
      const pts = list.filter((l) => l.lat != null);
      if (!pts.length) return;
      const b = new google.maps.LatLngBounds();
      for (const l of pts) b.extend({ lat: l.lat, lng: l.lng });
      map.fitBounds(b, 60);
      if (map.getZoom() > 16) map.setZoom(16);
    },
    resize() { /* Google Maps tracks its container */ },
  };
  return api;
}

// ---- MapLibre + OpenFreeMap --------------------------------------------

async function maplibreMap(el, { onSelect, onSelectBuilding, onMove, grouping = "separate" }) {
  const clustered = false; let last = [];
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: `${MAPLIBRE}/maplibre-gl.css` });
  document.head.append(link);
  await loadScript(`${MAPLIBRE}/maplibre-gl.js`);
  const styleUrl = () => `https://tiles.openfreemap.org/styles/${dark() ? "dark" : "positron"}`;
  let styled = styleUrl();
  const map = new maplibregl.Map({
    container: el,
    style: styled,
    center: [NYC.lng, NYC.lat],
    zoom: 10.5,
    attributionControl: { compact: true },
  });
  // the compass shows which way is north; click it to turn the map back north-up
  map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), "top-right");

  let data = { type: "FeatureCollection", features: [] };
  let hoods = null; // outlines, once turned on

  // neighborhood outlines and names, drawn under the dots
  const addHoods = () => {
    if (!hoods || map.getSource("hoods")) return;
    const before = map.getLayer("clusters") ? "clusters" : undefined;
    map.addSource("hoods", { type: "geojson", data: hoods });
    map.addLayer({ id: "hoods-fill", type: "fill", source: "hoods",
      paint: { "fill-color": css("ink"), "fill-opacity": ["case", ["==", ["get", "type"], 0], 0.025, 0.06] } }, before);
    map.addLayer({ id: "hoods-line", type: "line", source: "hoods",
      paint: { "line-color": css("ink"), "line-opacity": 0.45, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.6, 14, 1.4] } }, before);
    map.addLayer({ id: "hoods-label", type: "symbol", source: "hoods", minzoom: 11, filter: ["==", ["get", "type"], 0],
      layout: { "text-field": ["get", "name"], "text-size": ["interpolate", ["linear"], ["zoom"], 11, 10, 15, 13],
        "text-font": ["Noto Sans Regular"], "text-max-width": 8, "text-padding": 4 },
      paint: { "text-color": css("muted"), "text-halo-color": css("bg"), "text-halo-width": 1.4 } }, before);
  };
  const removeHoods = () => {
    for (const id of ["hoods-label", "hoods-line", "hoods-fill"]) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource("hoods")) map.removeSource("hoods");
  };
  // layers are added again whenever the base map style changes (light/dark)
  const addLayers = () => {
    const colors = ["match", ["get", "cat"],
      "likely", css("likely"), "building", css("building"), "text", css("text"), css("none")];
    map.addSource("listings", {
      type: "geojson", data,
      // only group dots when zoomed out past the whole city; at city view and closer every building shows
      cluster: clustered, clusterRadius: 28, clusterMaxZoom: CLUSTER_MAX_ZOOM,
      clusterProperties: { units: ["+", ["get", "n"]] }, // apartments, not buildings
    });
    map.addLayer({
      id: "clusters", type: "circle", source: "listings", filter: ["has", "point_count"],
      paint: {
        "circle-color": css("accent"), "circle-opacity": 0.85,
        "circle-radius": ["step", ["get", "units"], 14, 10, 18, 50, 24],
        "circle-stroke-width": 2, "circle-stroke-color": "#ffffff",
      },
    });
    map.addLayer({
      id: "cluster-count", type: "symbol", source: "listings", filter: ["has", "point_count"],
      layout: { "text-field": ["to-string", ["get", "units"]], "text-size": 12, "text-font": ["Noto Sans Bold"] },
      paint: { "text-color": css("accent-ink") },
    });
    map.addLayer({
      id: "points", type: "circle", source: "listings", filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-color": colors, "circle-radius": ["case", [">", ["get", "n"], 1], 11, 7],
        "circle-stroke-width": dark() ? 2 : 1.5, "circle-stroke-color": css("dot-ring"),
      },
    });
    // a building with several units shows how many
    map.addLayer({
      id: "point-count", type: "symbol", source: "listings",
      filter: ["all", ["!", ["has", "point_count"]], [">", ["get", "n"], 1]],
      layout: { "text-field": ["to-string", ["get", "n"]], "text-size": 11, "text-font": ["Noto Sans Bold"], "text-allow-overlap": true },
      // dark number with a light halo reads on every dot color, yellow included
      paint: { "text-color": "#1b1713", "text-halo-color": "rgba(255,255,255,.9)", "text-halo-width": 1.6 },
    });
  };
  map.on("style.load", () => { addLayers(); addHoods(); });
  await new Promise((r) => map.once("load", r));

  map.on("click", "clusters", async (e) => {
    const f = e.features[0];
    const zoom = await map.getSource("listings").getClusterExpansionZoom(f.properties.cluster_id);
    map.easeTo({ center: f.geometry.coordinates, zoom });
  });
  map.on("click", "points", (e) => {
    const urls = JSON.parse(e.features[0].properties.urls);
    if (urls.length > 1) onSelectBuilding(urls); else onSelect(urls[0]);
  });
  for (const layer of ["clusters", "points"]) {
    map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
  }
  const moved = () => {
    if (!el.clientWidth) return; // hidden (list view on a phone)
    const b = map.getBounds();
    onMove?.({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() });
  };
  map.on("moveend", moved);
  moved();
  // apartment spacing is in pixels, so redraw as the zoom changes (every quarter level)
  let zoomStep = Math.round(map.getZoom() * 4);
  map.on("zoom", () => {
    const z = Math.round(map.getZoom() * 4);
    if (z === zoomStep) return;
    zoomStep = z;
    if (grouping === "separate" && last.length) api.setListings(last);
  });

  const api = {
    setListings(list) {
      last = list;
      data = {
        type: "FeatureCollection",
        features: dots(list, grouping, 360 / (512 * 2 ** map.getZoom())).map((b) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [b.lng, b.lat] },
          properties: { urls: JSON.stringify(b.units.map((l) => l.url)), n: b.units.length, cat: b.cat },
        })),
      };
      map.getSource("listings")?.setData(data);
    },
    async setNeighborhoods(on) {
      if (!on) { hoods = null; removeHoods(); return; }
      hoods = await loadHoods();
      // add now, or once the map finishes what it's loading (addHoods skips a second add)
      if (map.isStyleLoaded()) addHoods(); else map.once("idle", addHoods);
    },
    setGrouping(mode) { grouping = mode; this.setListings(last); },
    setTheme() {
      if (styleUrl() !== styled) { styled = styleUrl(); map.setStyle(styled, { diff: false }); return; } // layers re-added on style.load
      if (!map.getLayer("points")) return; // a new style is still loading; its layers pick up the colors
      if (map.getSource("hoods")) { removeHoods(); addHoods(); } // outline and label colors follow the theme
      map.setPaintProperty("points", "circle-color", ["match", ["get", "cat"],
        "likely", css("likely"), "building", css("building"), "text", css("text"), css("none")]);
    },
    focus(l) {
      if (l?.lat == null) return;
      map.easeTo({ center: [l.lng, l.lat], zoom: Math.max(map.getZoom(), 15) });
    },
    fit(list) {
      const pts = list.filter((l) => l.lat != null);
      if (!pts.length) return;
      const b = new maplibregl.LngLatBounds();
      for (const l of pts) b.extend([l.lng, l.lat]);
      map.fitBounds(b, { padding: 60, maxZoom: 16, duration: 600 });
    },
    resize() { map.resize(); },
  };
  return api;
}
