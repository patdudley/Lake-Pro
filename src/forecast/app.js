import { windFrameSource } from "../map/windFrameSource.js";
import { lakeSpots } from "../spots/index.js";

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
    renderSpot(lakeSpots.find((spot) => spot.slug === select.value) || lakeSpots[0]);
  });
}

function renderSpot(spot) {
  document.getElementById("spotName").textContent = spot.name;
  document.getElementById("spotLocation").textContent = spot.location;
  document.getElementById("spotLatitude").textContent = spot.latitude.toFixed(4);
  document.getElementById("spotLongitude").textContent = spot.longitude.toFixed(4);
  document.getElementById("shorelineStatus").textContent = spot.shorelineOrientation.status;
}

function initMap() {
  const status = document.getElementById("mapStatus");
  if (!window.maplibregl) {
    status.textContent = "Map library unavailable";
    return;
  }

  const map = new window.maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "OpenStreetMap contributors",
        },
      },
      layers: [{ id: "osm", type: "raster", source: "osm" }],
    },
    center: [-119.7, 39.1],
    zoom: 5,
    attributionControl: true,
  });

  map.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.once("load", () => {
    status.textContent = "Map ready";
    document.getElementById("windLayerNote").textContent = `${windFrameSource.pipeline} slot active: ${windFrameSource.note}`;
  });
}

const activeSpot = selectedSpot();
renderSpotSwitcher(activeSpot);
renderSpot(activeSpot);
renderForecastStrip();
initMap();
