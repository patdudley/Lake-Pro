import { windFrameForSpot } from "../map/windFrameSource.js";
import { lakeSpots } from "../spots/index.js";

let lakeMap = null;
let currentSpot = null;
let activeMapMode = "boating";

const mapLayerUrls = {
  payetteBathymetry: "https://mccallgis.mccall.id.us/mcgis/rest/services/PUB/Payette_Lake_Bathymetry_Contours/FeatureServer/1/query?where=1%3D1&outFields=Contour&returnGeometry=true&outSR=4326&f=geojson",
  payetteNoWake: "https://services6.arcgis.com/ikurHvtarxfN6u3u/arcgis/rest/services/WATERWAYS_ORDINANCE/FeatureServer/1/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson",
  payetteSetback: "https://services6.arcgis.com/ikurHvtarxfN6u3u/arcgis/rest/services/WATERWAYS_ORDINANCE/FeatureServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson",
};

const placeholderForecast = Array.from({ length: 10 }, (_, index) => ({
  label: index === 0 ? "Today" : new Date(Date.now() + index * 86400000).toLocaleDateString("en-US", { weekday: "short" }),
  grade: "--",
  summary: "Stubbed",
}));

function renderForecastStrip() {
  const strip = document.getElementById("forecastStrip");
  strip.replaceChildren(...placeholderForecast.map((day) => {
    const card = document.createElement("article");
    card.className = "forecast-day";
    card.innerHTML = `
      <span>${day.label}</span>
      <strong>${day.grade}</strong>
      <em>${day.summary}</em>
    `;
    return card;
  }));
}

async function fetchGeoJson(url) {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`${url} unavailable`);
  return response.json();
}

function selectedSpot() {
  const params = new URLSearchParams(window.location.search);
  return lakeSpots.find((spot) => spot.slug === params.get("spot")) || lakeSpots[0];
}

function renderSpotSwitcher(activeSpot) {
  const select = document.getElementById("spotSelect");
  select.replaceChildren(...lakeSpots.map((spot) => {
    const option = document.createElement("option");
    option.value = spot.slug;
    option.textContent = spot.name;
    option.selected = spot.slug === activeSpot.slug;
    return option;
  }));
  select.addEventListener("change", () => {
    const url = new URL(window.location.href);
    url.searchParams.set("spot", select.value);
    window.history.replaceState({}, "", url);
    const nextSpot = lakeSpots.find((spot) => spot.slug === select.value) || lakeSpots[0];
    renderSpot(nextSpot);
    updateMapForSpot(nextSpot);
  });
}

function renderMapModeControls() {
  const controls = document.querySelector(".map-mode-bar");
  if (!controls) return;
  controls.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-map-mode]");
    if (!button) return;
    activeMapMode = button.dataset.mapMode;
    controls.querySelectorAll("button").forEach((control) => {
      control.classList.toggle("is-active", control === button);
    });
    setMapMode(activeMapMode);
  });
}

function renderSpot(spot) {
  currentSpot = spot;
  document.getElementById("spotName").textContent = spot.name;
  document.getElementById("spotLocation").textContent = spot.location;
  const cameraCard = document.getElementById("cameraCard");
  if (cameraCard) cameraCard.hidden = spot.slug !== "payette-lake";
}

function boundsPolygon(bounds) {
  const [west, south, east, north] = bounds;
  return {
    type: "Feature",
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [[
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ]],
    },
  };
}

function updateMapForSpot(spot) {
  const windFrame = windFrameForSpot(spot);
  updateMapNote(spot);

  if (!lakeMap || !windFrame) return;

  lakeMap.flyTo({
    center: [spot.longitude, spot.latitude],
    zoom: spot.slug === "lake-tahoe" ? 8.35 : 11.15,
    essential: true,
  });

  const source = lakeMap.getSource("wind-frame-extent");
  if (source) source.setData(boundsPolygon(windFrame.bounds));
  setMapMode(activeMapMode);
}

function updateMapNote(spot) {
  const note = document.getElementById("windLayerNote");
  if (activeMapMode === "wind") {
    const windFrame = windFrameForSpot(spot);
    note.textContent = windFrame
      ? `${windFrame.pipeline} slot active for ${spot.name}: ${windFrame.note}`
      : "Cropped-wind frame pipeline slot: no wind frame configured.";
    return;
  }

  if (spot.slug === "payette-lake") {
    note.textContent = "Boating Areas mode: Payette depth contours and official no-wake/setback layers are shown. Blue/pink boating scores, wind protection, crowding downgrades, and verified danger restrictions are pending.";
  } else {
    note.textContent = "Boating Areas mode is scaffolded. Tahoe depth, wind-protection, crowding, and danger layers still need verified sources.";
  }
}

function setLayerVisibility(ids, visible) {
  if (!lakeMap) return;
  ids.forEach((id) => {
    if (lakeMap.getLayer(id)) {
      lakeMap.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
  });
}

function setMapMode(mode) {
  if (!lakeMap || !currentSpot) return;
  const isBoating = mode === "boating";
  setLayerVisibility(["bathymetry-contours", "payette-no-wake-fill", "payette-no-wake-line", "payette-setback-line"], isBoating && currentSpot.slug === "payette-lake");
  setLayerVisibility(["wind-frame-extent-fill", "wind-frame-extent-line"], !isBoating);
  const legend = document.getElementById("mapLegend");
  if (legend) legend.hidden = !isBoating;
  updateMapNote(currentSpot);
}

async function addPayetteBoatingLayers() {
  if (!lakeMap) return;
  try {
    const [bathymetry, noWake, setback] = await Promise.all([
      fetchGeoJson(mapLayerUrls.payetteBathymetry),
      fetchGeoJson(mapLayerUrls.payetteNoWake),
      fetchGeoJson(mapLayerUrls.payetteSetback),
    ]);

    lakeMap.addSource("payette-bathymetry", { type: "geojson", data: bathymetry });
    lakeMap.addSource("payette-no-wake", { type: "geojson", data: noWake });
    lakeMap.addSource("payette-setback", { type: "geojson", data: setback });

    lakeMap.addLayer({
      id: "payette-no-wake-fill",
      type: "fill",
      source: "payette-no-wake",
      paint: {
        "fill-color": "#f20bc6",
        "fill-opacity": 0.34,
      },
    });
    lakeMap.addLayer({
      id: "payette-no-wake-line",
      type: "line",
      source: "payette-no-wake",
      paint: {
        "line-color": "#f20bc6",
        "line-width": 3,
      },
    });
    lakeMap.addLayer({
      id: "payette-setback-line",
      type: "line",
      source: "payette-setback",
      paint: {
        "line-color": "#ef233c",
        "line-width": 3,
        "line-dasharray": [2, 2],
      },
    });
    lakeMap.addLayer({
      id: "bathymetry-contours",
      type: "line",
      source: "payette-bathymetry",
      paint: {
        "line-color": "#11bce9",
        "line-width": 2.6,
        "line-opacity": 0.9,
      },
    });
  } catch (error) {
    console.warn("[LakePro] Payette boating layers unavailable", error);
  }
}

function resizeMapToPanel() {
  if (!lakeMap || !currentSpot) return;
  lakeMap.resize();
  updateMapForSpot(currentSpot);
}

function initMap(activeSpot) {
  const status = document.getElementById("mapStatus");
  if (!window.maplibregl) {
    status.textContent = "Map library unavailable";
    return;
  }

  lakeMap = new window.maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "OpenStreetMap contributors, CARTO",
        },
      },
      layers: [{ id: "osm", type: "raster", source: "osm" }],
    },
    center: [activeSpot.longitude, activeSpot.latitude],
    zoom: activeSpot.slug === "lake-tahoe" ? 8.35 : 11.15,
    attributionControl: true,
  });

  lakeMap.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), "top-right");
  requestAnimationFrame(resizeMapToPanel);
  window.setTimeout(resizeMapToPanel, 250);
  window.setTimeout(resizeMapToPanel, 1000);
  window.addEventListener("resize", resizeMapToPanel);
  lakeMap.once("load", () => {
    const windFrame = windFrameForSpot(activeSpot);
    lakeMap.addSource("wind-frame-extent", {
      type: "geojson",
      data: boundsPolygon(windFrame.bounds),
    });
    lakeMap.addLayer({
      id: "wind-frame-extent-fill",
      type: "fill",
      source: "wind-frame-extent",
      paint: {
        "fill-color": "#2563eb",
        "fill-opacity": 0.08,
      },
    });
    lakeMap.addLayer({
      id: "wind-frame-extent-line",
      type: "line",
      source: "wind-frame-extent",
      paint: {
        "line-color": "#2563eb",
        "line-width": 2,
        "line-dasharray": [2, 2],
      },
    });
    status.textContent = "Map ready";
    addPayetteBoatingLayers().finally(() => {
      resizeMapToPanel();
      setMapMode(activeMapMode);
    });
  });
}

const activeSpot = selectedSpot();
renderMapModeControls();
renderSpotSwitcher(activeSpot);
renderSpot(activeSpot);
renderForecastStrip();
initMap(activeSpot);
