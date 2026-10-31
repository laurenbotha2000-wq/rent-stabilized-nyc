// Map with clustered listing markers. Google Maps when an API key is
// configured; otherwise MapLibre with free OpenFreeMap tiles (no key).
//   const map = await createMap(el, { googleKey, googleMapId, onSelect });
//   map.setListings(listings);  map.focus(listing);

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

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;

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

async function googleMap(el, { googleKey, googleMapId, onSelect }) {
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
  });
  const clusterer = new markerClusterer.MarkerClusterer({ map, markers: [] });
  let markers = new globalThis.Map();

  return {
    setListings(list) {
      clusterer.clearMarkers();
      markers = new globalThis.Map();
      const made = [];
      for (const l of list) {
        if (l.lat == null || l.lng == null) continue;
        const pin = new PinElement({ background: css(category(l)), borderColor: "#ffffff", glyphColor: "#ffffff", scale: 0.9 });
        const m = new AdvancedMarkerElement({ position: { lat: l.lat, lng: l.lng }, content: pin.element, title: l.address || "" });
        m.addListener("click", () => onSelect(l.url));
        markers.set(l.url, m);
        made.push(m);
      }
      clusterer.addMarkers(made);
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
}

// ---- MapLibre + OpenFreeMap --------------------------------------------

async function maplibreMap(el, { onSelect }) {
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: `${MAPLIBRE}/maplibre-gl.css` });
  document.head.append(link);
  await loadScript(`${MAPLIBRE}/maplibre-gl.js`);
  const map = new maplibregl.Map({
    container: el,
    style: `https://tiles.openfreemap.org/styles/${dark() ? "dark" : "positron"}`,
    center: [NYC.lng, NYC.lat],
    zoom: 10.5,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  await new Promise((r) => map.on("load", r));

  const colors = ["match", ["get", "cat"],
    "likely", css("likely"), "building", css("building"), "text", css("text"), css("none")];
  map.addSource("listings", {
    type: "geojson", data: { type: "FeatureCollection", features: [] },
    cluster: true, clusterRadius: 40, clusterMaxZoom: 14,
  });
  map.addLayer({
    id: "clusters", type: "circle", source: "listings", filter: ["has", "point_count"],
    paint: {
      "circle-color": css("accent"), "circle-opacity": 0.85,
      "circle-radius": ["step", ["get", "point_count"], 14, 10, 18, 50, 24],
      "circle-stroke-width": 2, "circle-stroke-color": "#ffffff",
    },
  });
  map.addLayer({
    id: "cluster-count", type: "symbol", source: "listings", filter: ["has", "point_count"],
    layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 12, "text-font": ["Noto Sans Bold"] },
    paint: { "text-color": css("accent-ink") },
  });
  map.addLayer({
    id: "points", type: "circle", source: "listings", filter: ["!", ["has", "point_count"]],
    paint: { "circle-color": colors, "circle-radius": 7, "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" },
  });

  map.on("click", "clusters", async (e) => {
    const f = e.features[0];
    const zoom = await map.getSource("listings").getClusterExpansionZoom(f.properties.cluster_id);
    map.easeTo({ center: f.geometry.coordinates, zoom });
  });
  map.on("click", "points", (e) => onSelect(e.features[0].properties.url));
  for (const layer of ["clusters", "points"]) {
    map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
  }

  return {
    setListings(list) {
      map.getSource("listings").setData({
        type: "FeatureCollection",
        features: list.filter((l) => l.lat != null && l.lng != null).map((l) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [l.lng, l.lat] },
          properties: { url: l.url, cat: category(l) },
        })),
      });
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
