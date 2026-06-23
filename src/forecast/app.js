import { windFrameForSpot } from "../map/windFrameSource.js";
import { lakeSpots } from "../spots/index.js";

let lakeMap = null;
let currentSpot = null;

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

function renderSpot(spot) {
  currentSpot = spot;
  document.getElementById("spotName").textContent = spot.name;
  document.getElementById("spotLocation").textContent = spot.location;
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
  document.getElementById("windLayerNote").textContent = windFrame
    ? `${windFrame.pipeline} slot active for ${spot.name}: ${windFrame.note}`
    : "Cropped-wind frame pipeline slot: no wind frame configured.";

  if (!lakeMap || !windFrame) return;

  lakeMap.flyTo({
    center: [spot.longitude, spot.latitude],
    zoom: spot.slug === "lake-tahoe" ? 8.35 : 10.25,
    essential: true,
  });

  const source = lakeMap.getSource("wind-frame-extent");
  if (source) source.setData(boundsPolygon(windFrame.bounds));
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
    zoom: activeSpot.slug === "lake-tahoe" ? 8.35 : 10.25,
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
    resizeMapToPanel();
  });
}

const activeSpot = selectedSpot();
renderSpotSwitcher(activeSpot);
renderSpot(activeSpot);
renderForecastStrip();
initMap(activeSpot);
