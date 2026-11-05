// Map with clustered listing markers. Google Maps when an API key is
// configured; otherwise MapLibre with free OpenFreeMap tiles (no key).
// Units in the same building share one marker showing how many there are.
//   const map = await createMap(el, { googleKey, googleMapId, onSelect, onSelectBuilding, onMove });
//   map.setListings(listings);  map.focus(listing);  map.setTheme();
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

async function googleMap(el, { googleKey, googleMapId, onSelect, onSelectBuilding, onMove }) {
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
  const clusterer = new markerClusterer.MarkerClusterer({ map, markers: [] });
  let last = [];

  return {
    setListings(list) {
      last = list;
      clusterer.clearMarkers();
      const made = [];
      for (const b of buildings(list)) {
        const n = b.units.length;
        const pin = new PinElement({ background: css(b.cat), borderColor: "#ffffff", glyphColor: "#ffffff",
          glyph: n > 1 ? String(n) : undefined, scale: n > 1 ? 1.1 : 0.9 });
        const m = new AdvancedMarkerElement({ position: { lat: b.lat, lng: b.lng }, content: pin.element,
          title: n > 1 ? `${n} apartments at ${b.units[0].address || "this building"}` : b.units[0].address || "" });
        m.addListener("click", () => (n > 1 ? onSelectBuilding(b.units.map((l) => l.url)) : onSelect(b.units[0].url)));
        made.push(m);
      }
      clusterer.addMarkers(made);
    },
    setTheme() { this.setListings(last); },
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
}

// ---- MapLibre + OpenFreeMap --------------------------------------------

async function maplibreMap(el, { onSelect, onSelectBuilding, onMove }) {
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
  // layers are added again whenever the base map style changes (light/dark)
  const addLayers = () => {
    const colors = ["match", ["get", "cat"],
      "likely", css("likely"), "building", css("building"), "text", css("text"), css("none")];
    map.addSource("listings", {
      type: "geojson", data,
      cluster: true, clusterRadius: 40, clusterMaxZoom: 14,
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
        "circle-stroke-width": 2, "circle-stroke-color": "#ffffff",
      },
    });
    // a building with several units shows how many
    map.addLayer({
      id: "point-count", type: "symbol", source: "listings",
      filter: ["all", ["!", ["has", "point_count"]], [">", ["get", "n"], 1]],
      layout: { "text-field": ["to-string", ["get", "n"]], "text-size": 11, "text-font": ["Noto Sans Bold"], "text-allow-overlap": true },
      paint: { "text-color": "#ffffff", "text-halo-color": "rgba(0,0,0,.35)", "text-halo-width": 1 },
    });
  };
  map.on("style.load", addLayers);
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

  return {
    setListings(list) {
      data = {
        type: "FeatureCollection",
        features: buildings(list).map((b) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [b.lng, b.lat] },
          properties: { urls: JSON.stringify(b.units.map((l) => l.url)), n: b.units.length, cat: b.cat },
        })),
      };
      map.getSource("listings")?.setData(data);
    },
    setTheme() {
      if (styleUrl() !== styled) { styled = styleUrl(); map.setStyle(styled, { diff: false }); return; } // layers re-added on style.load
      if (!map.getLayer("points")) return; // a new style is still loading; its layers pick up the colors
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
}
