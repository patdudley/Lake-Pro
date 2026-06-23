import { windFrameForSpot } from "../map/windFrameSource.js";
import { lakeSpots } from "../spots/index.js";

let lakeMap = null;
let currentSpot = null;
let activeMapMode = "boating";
let windFrames = [];
let windFrameIndex = 0;
let windTimer = null;
let windMarker = null;

const mapLayerUrls = {
  payetteBathymetry: "data/live/map_layers/payette_bathymetry_contours.geojson",
  payetteNoWake: "data/live/map_layers/payette_no_wake_zone.geojson",
  payetteSetback: "data/live/map_layers/payette_shoreline_setback.geojson",
};

const placeholderForecast = Array.from({ length: 10 }, (_, index) => ({
  label: index === 0 ? "Today" : new Date(Date.now() + index * 86400000).toLocaleDateString("en-US", { weekday: "short" }),
  grade: "--",
  summary: "Stubbed",
}));

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} unavailable`);
  return response.json();
}

function dayLabel(date, index) {
  if (index === 0) return "Today";
  return new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" });
}

function renderForecastStrip(days = placeholderForecast) {
  const strip = document.getElementById("forecastStrip");
  strip.replaceChildren(...days.map((day, index) => {
    const card = document.createElement("article");
    card.className = "forecast-day";
    card.innerHTML = `
      <span>${day.label || dayLabel(day.date, index)}</span>
      <strong>${day.grade || "--"}</strong>
      <em>${day.chop_proxy_ft != null ? `${day.chop_proxy_ft} ft chop proxy` : (day.summary || "Stubbed")}</em>
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
  loadLiveSpotData(spot);
  loadWindTimelapse(spot);
}

function renderWindChart(hourly = {}) {
  const chart = document.querySelector(".wind-placeholder");
  if (!chart) return;
  const times = hourly.time || [];
  const speeds = hourly.wind_speed_10m || [];
  const points = times.slice(0, 24).map((time, index) => ({ time, speed: speeds[index] || 0 }));
  if (!points.length) {
    chart.innerHTML = "<span>Wind pending</span>";
    return;
  }
  const max = Math.max(12, ...points.map((point) => point.speed));
  chart.innerHTML = `<div class="wind-bars">${points.map((point) => {
    const height = Math.max(8, Math.round((point.speed / max) * 150));
    const hour = point.time.slice(11, 13);
    return `<i style="height:${height}px"><span>${Math.round(point.speed)}</span><em>${hour}</em></i>`;
  }).join("")}</div>`;
}

function renderLiveSpotData(bundle) {
  const latest = bundle.latest || {};
  document.getElementById("conditionGrade").textContent = latest.grade || "--";
  document.getElementById("conditionSummary").textContent = latest.chop_proxy_ft != null
    ? `${latest.chop_proxy_ft} ft chop proxy`
    : "Rating pending";
  document.getElementById("windSpeed").textContent = latest.wind_speed_max_mph != null
    ? `${Math.round(latest.wind_speed_max_mph)} mph ${latest.wind_direction_label || ""}`.trim()
    : "Pending";
  document.getElementById("bestWindow").textContent = latest.best_window || "Pending";
  const fill = document.getElementById("scoreFill");
  if (fill && latest.score != null) fill.style.width = `${Math.max(6, Math.min(100, latest.score))}%`;
  const report = document.querySelector(".daily-report p");
  if (report) report.textContent = latest.report || latest.summary || "Lake Pro data is pending.";
  renderForecastStrip(bundle.ten_day || []);
  renderWindChart(bundle.hourly || {});
}

async function loadLiveSpotData(spot) {
  try {
    const bundle = await fetchJson(`data/live/spots/${spot.slug}.json`);
    renderLiveSpotData(bundle);
  } catch (error) {
    console.warn("[LakePro] Live spot data unavailable", error);
    document.getElementById("conditionGrade").textContent = "--";
    document.getElementById("conditionSummary").textContent = "Rating pending";
    document.getElementById("windSpeed").textContent = "Stubbed";
    document.getElementById("bestWindow").textContent = "Stubbed";
    renderForecastStrip();
    renderWindChart();
  }
}

function flowBearing(frame) {
  const fromDirection = Number(frame?.wind_direction_deg);
  if (!Number.isFinite(fromDirection)) return 0;
  return (fromDirection + 180) % 360;
}

function endpointFromBearing(spot, bearing, speed) {
  const radians = bearing * Math.PI / 180;
  const distance = 0.012 + Math.min(0.035, (Number(speed) || 0) * 0.0022);
  const latitudeScale = Math.max(0.2, Math.cos(spot.latitude * Math.PI / 180));
  return [
    spot.longitude + Math.sin(radians) * distance / latitudeScale,
    spot.latitude + Math.cos(radians) * distance,
  ];
}

function windVectorFeature(spot, frame) {
  const bearing = flowBearing(frame);
  return {
    type: "Feature",
    properties: {
      speed: frame?.wind_speed_mph || 0,
      bearing,
    },
    geometry: {
      type: "LineString",
      coordinates: [
        [spot.longitude, spot.latitude],
        endpointFromBearing(spot, bearing, frame?.wind_speed_mph),
      ],
    },
  };
}

function formatFrameTime(time) {
  if (!time) return "Wind timeline pending";
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return time;
  return date.toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ensureWindMarker() {
  if (!lakeMap || windMarker) return;
  const element = document.createElement("div");
  element.className = "wind-map-arrow-marker";
  const arrow = document.createElement("div");
  arrow.className = "wind-map-arrow";
  element.append(arrow);
  windMarker = new window.maplibregl.Marker({ element, anchor: "center" })
    .setLngLat([currentSpot.longitude, currentSpot.latitude])
    .addTo(lakeMap);
}

function renderWindFrame(index = windFrameIndex) {
  windFrameIndex = Math.max(0, Math.min(index, Math.max(0, windFrames.length - 1)));
  const frame = windFrames[windFrameIndex];
  const slider = document.getElementById("windFrameSlider");
  const label = document.getElementById("windFrameLabel");
  if (slider) {
    slider.max = String(Math.max(0, windFrames.length - 1));
    slider.value = String(windFrameIndex);
  }

  if (!frame || !currentSpot) {
    if (label) label.textContent = "Wind timeline pending";
    return;
  }

  const bearing = flowBearing(frame);
  if (label) {
    label.textContent = `${formatFrameTime(frame.time)} · ${Math.round(frame.wind_speed_mph || 0)} mph ${frame.wind_direction_label || ""}`.trim();
  }

  if (lakeMap) {
    ensureWindMarker();
    if (windMarker) {
      windMarker.setLngLat([currentSpot.longitude, currentSpot.latitude]);
      const arrow = windMarker.getElement().querySelector(".wind-map-arrow");
      if (arrow) arrow.style.transform = `rotate(${bearing}deg)`;
    }
    const source = lakeMap.getSource("wind-vector");
    if (source) {
      source.setData(windVectorFeature(currentSpot, frame));
    }
  }
}

function stopWindTimelapse() {
  if (windTimer) {
    window.clearInterval(windTimer);
    windTimer = null;
  }
  const button = document.getElementById("windPlayButton");
  if (button) button.textContent = "Play";
}

function startWindTimelapse() {
  if (windTimer || windFrames.length < 2) return;
  const button = document.getElementById("windPlayButton");
  if (button) button.textContent = "Pause";
  windTimer = window.setInterval(() => {
    renderWindFrame((windFrameIndex + 1) % windFrames.length);
  }, 850);
}

function renderTimelapseControls() {
  const slider = document.getElementById("windFrameSlider");
  const button = document.getElementById("windPlayButton");
  if (slider) {
    slider.max = String(Math.max(0, windFrames.length - 1));
    slider.value = String(windFrameIndex);
    slider.oninput = () => {
      stopWindTimelapse();
      renderWindFrame(Number(slider.value));
    };
  }
  if (button) {
    button.onclick = () => {
      if (windTimer) stopWindTimelapse();
      else startWindTimelapse();
    };
  }
  renderWindFrame(0);
}

async function loadWindTimelapse(spot) {
  stopWindTimelapse();
  windFrames = [];
  windFrameIndex = 0;
  try {
    const bundle = await fetchJson(`data/live/wind_frames/${spot.slug}.json`);
    windFrames = Array.isArray(bundle.frames) ? bundle.frames : [];
  } catch (error) {
    console.warn("[LakePro] Wind timelapse unavailable", error);
  }
  renderTimelapseControls();
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
  const sources = document.getElementById("mapSources");
  if (activeMapMode === "wind") {
    const windFrame = windFrameForSpot(spot);
    note.textContent = windFrame
      ? `${windFrame.pipeline} slot active for ${spot.name}: ${windFrame.note}`
      : "Cropped-wind frame pipeline slot: no wind frame configured.";
    if (sources) sources.textContent = "Wind time-lapse uses generated Open-Meteo hourly wind frames.";
    return;
  }

  if (spot.slug === "payette-lake") {
    note.textContent = "Boating Areas mode: Payette depth contours and official no-wake/setback layers are shown. Blue/pink boating scores, wind protection, crowding downgrades, and verified danger restrictions are pending.";
    if (sources) {
      sources.innerHTML = 'Sources: <a href="https://mccallgis.mccall.id.us/mcgis/rest/services/PUB/Payette_Lake_Bathymetry_Contours/FeatureServer/info/iteminfo" target="_blank" rel="noopener">McCall GIS bathymetry</a> and <a href="https://services6.arcgis.com/ikurHvtarxfN6u3u/arcgis/rest/services/WATERWAYS_ORDINANCE/FeatureServer" target="_blank" rel="noopener">Valley County waterways ordinance</a>.';
    }
  } else {
    note.textContent = "Boating Areas mode is scaffolded. Tahoe depth, wind-protection, crowding, and danger layers still need verified sources.";
    if (sources) sources.textContent = "Tahoe boating-area source layers are pending. Wind time-lapse uses generated Open-Meteo hourly wind frames.";
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
  setLayerVisibility(["wind-frame-extent-fill", "wind-frame-extent-line", "wind-vector-line"], !isBoating);
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
    lakeMap.addSource("wind-vector", {
      type: "geojson",
      data: windVectorFeature(activeSpot, windFrames[windFrameIndex] || {}),
    });
    lakeMap.addLayer({
      id: "wind-vector-line",
      type: "line",
      source: "wind-vector",
      paint: {
        "line-color": "#f20bc6",
        "line-width": 4,
        "line-opacity": 0.82,
      },
    });
    status.textContent = "Map ready";
    addPayetteBoatingLayers().finally(() => {
      resizeMapToPanel();
      setMapMode(activeMapMode);
      renderWindFrame(windFrameIndex);
    });
  });
}

const activeSpot = selectedSpot();
renderMapModeControls();
renderSpotSwitcher(activeSpot);
renderSpot(activeSpot);
initMap(activeSpot);
