import { windFrameForSpot } from "../map/windFrameSource.js";
import { lakeSpots } from "../spots/index.js";

let lakeMap = null;
let currentSpot = null;
let activeMapMode = "boating";
let windFrames = [];
let windFrameIndex = 0;
let windTimer = null;
let windMarker = null;
let lakeSurfaceCanvas = null;
let lakeSurfaceContext = null;
let lakeSurfaceRings = [];
let lakeSurfaceParticles = [];
let lakeSurfaceAnimation = null;
let lastParticleFrame = 0;
let loadedShorelineSlug = "";

const mapLayerUrls = {
  payetteBathymetry: "data/live/map_layers/payette_bathymetry_contours.geojson",
  payetteNoWake: "data/live/map_layers/payette_no_wake_zone.geojson",
  payetteSetback: "data/live/map_layers/payette_shoreline_setback.geojson",
  shorelines: {
    "lake-tahoe": "data/live/map_layers/lake-tahoe_shoreline.geojson",
    "payette-lake": "data/live/map_layers/payette-lake_shoreline.geojson",
  },
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

function weatherIconClass(code) {
  if (code == null) return "weather-cloud";
  const value = Number(code);
  if (value === 0) return "weather-sun";
  if (value === 1 || value === 2) return "weather-partly";
  if (value === 3 || value === 45 || value === 48) return "weather-cloud";
  if ((value >= 51 && value <= 67) || (value >= 80 && value <= 82)) return "weather-rain";
  if (value >= 71 && value <= 77) return "weather-snow";
  if (value >= 95) return "weather-storm";
  return "weather-cloud";
}

function forecastDetail(day) {
  if (day.best_window_wind_mph != null) {
    return `${day.best_window_wind_mph} mph best window`;
  }
  if (day.chop_proxy_ft != null) return `${day.chop_proxy_ft} ft chop proxy`;
  return day.summary || "Stubbed";
}

function temperatureRange(day) {
  if (day.temperature_2m_max == null || day.temperature_2m_min == null) return "";
  return `<span class="forecast-temps">${Math.round(day.temperature_2m_max)}&deg; <small>${Math.round(day.temperature_2m_min)}&deg;</small></span>`;
}

function renderForecastStrip(days = placeholderForecast) {
  const strip = document.getElementById("forecastStrip");
  strip.replaceChildren(...days.map((day, index) => {
    const card = document.createElement("article");
    card.className = "forecast-day";
    card.innerHTML = `
      <span>${day.label || dayLabel(day.date, index)}</span>
      <i class="weather-icon ${weatherIconClass(day.weather_code)}" aria-hidden="true"></i>
      ${temperatureRange(day)}
      <strong>${day.grade || "--"}</strong>
      <em>${forecastDetail(day)}</em>
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
  loadLakeShoreline(spot);
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

function extractLakeRings(geojson) {
  const rings = [];
  for (const feature of geojson?.features || []) {
    const geometry = feature.geometry || {};
    if (geometry.type === "Polygon") {
      rings.push(...geometry.coordinates.map((polygon) => polygon));
    }
    if (geometry.type === "MultiPolygon") {
      rings.push(...geometry.coordinates);
    }
  }
  return rings;
}

async function loadLakeShoreline(spot) {
  const url = mapLayerUrls.shorelines[spot.slug];
  if (loadedShorelineSlug === spot.slug && lakeSurfaceRings.length) {
    drawLakeSurfaceOverlay(performance.now());
    return;
  }
  if (!url) {
    lakeSurfaceRings = [];
    lakeSurfaceParticles = [];
    loadedShorelineSlug = "";
    return;
  }
  try {
    const shoreline = await fetchGeoJson(url);
    if (currentSpot?.slug !== spot.slug) return;
    lakeSurfaceRings = extractLakeRings(shoreline);
    lakeSurfaceParticles = [];
    loadedShorelineSlug = spot.slug;
    drawLakeSurfaceOverlay(performance.now());
  } catch (error) {
    console.warn("[LakePro] Shoreline mask unavailable", error);
    lakeSurfaceRings = [];
    lakeSurfaceParticles = [];
    loadedShorelineSlug = "";
  }
}

function ensureLakeSurfaceCanvas() {
  if (!lakeMap || lakeSurfaceCanvas) return;
  lakeSurfaceCanvas = document.createElement("canvas");
  lakeSurfaceCanvas.className = "lake-surface-overlay";
  lakeSurfaceContext = lakeSurfaceCanvas.getContext("2d");
  lakeMap.getCanvasContainer().append(lakeSurfaceCanvas);
  startLakeSurfaceAnimation();
}

function resizeLakeSurfaceCanvas() {
  if (!lakeMap || !lakeSurfaceCanvas) return 1;
  const mapCanvas = lakeMap.getCanvas();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(mapCanvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(mapCanvas.clientHeight * dpr));
  if (lakeSurfaceCanvas.width !== width || lakeSurfaceCanvas.height !== height) {
    lakeSurfaceCanvas.width = width;
    lakeSurfaceCanvas.height = height;
    lakeSurfaceParticles = [];
  }
  lakeSurfaceCanvas.style.width = `${mapCanvas.clientWidth}px`;
  lakeSurfaceCanvas.style.height = `${mapCanvas.clientHeight}px`;
  return dpr;
}

function projectedLakePolygons(dpr) {
  if (!lakeMap) return [];
  return lakeSurfaceRings.map((polygon) => polygon.map((ring) => ring.map(([lng, lat]) => {
    const point = lakeMap.project([lng, lat]);
    return [point.x * dpr, point.y * dpr];
  })));
}

function tracePolygonPath(context, polygons) {
  context.beginPath();
  for (const polygon of polygons) {
    for (const ring of polygon) {
      ring.forEach(([x, y], index) => {
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.closePath();
    }
  }
}

function polygonBounds(polygons) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const [x, y] of ring) {
        bounds.minX = Math.min(bounds.minX, x);
        bounds.minY = Math.min(bounds.minY, y);
        bounds.maxX = Math.max(bounds.maxX, x);
        bounds.maxY = Math.max(bounds.maxY, y);
      }
    }
  }
  return bounds;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [xi, yi] = ring[index];
    const [xj, yj] = ring[previous];
    const intersects = ((yi > point.y) !== (yj > point.y))
      && (point.x < (xj - xi) * (point.y - yi) / ((yj - yi) || 1e-9) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInLake(point, polygons) {
  return polygons.some((polygon) => {
    if (!pointInRing(point, polygon[0])) return false;
    return !polygon.slice(1).some((hole) => pointInRing(point, hole));
  });
}

function randomLakePoint(bounds, polygons) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const point = {
      x: bounds.minX + Math.random() * (bounds.maxX - bounds.minX),
      y: bounds.minY + Math.random() * (bounds.maxY - bounds.minY),
      phase: Math.random() * Math.PI * 2,
    };
    if (pointInLake(point, polygons)) return point;
  }
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    phase: Math.random() * Math.PI * 2,
  };
}

function drawLakeGradient(context, polygons, bounds, speed) {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const centerX = bounds.minX + width * 0.52;
  const centerY = bounds.minY + height * 0.52;
  const radius = Math.max(width, height) * 0.58;

  context.save();
  tracePolygonPath(context, polygons);
  context.clip("evenodd");

  const base = context.createLinearGradient(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
  base.addColorStop(0, "rgba(17, 188, 233, 0.92)");
  base.addColorStop(0.45, "rgba(23, 156, 238, 0.9)");
  base.addColorStop(1, "rgba(13, 99, 255, 0.84)");
  context.fillStyle = base;
  context.fillRect(bounds.minX, bounds.minY, width, height);

  const exposure = Math.max(0, Math.min(0.92, (speed - 4) / 12));
  if (exposure > 0.02) {
    const rough = context.createRadialGradient(centerX, centerY, radius * 0.08, centerX, centerY, radius);
    rough.addColorStop(0, `rgba(242, 11, 198, ${0.82 * exposure})`);
    rough.addColorStop(0.46, `rgba(242, 11, 198, ${0.58 * exposure})`);
    rough.addColorStop(0.78, `rgba(11, 88, 255, ${0.16 * exposure})`);
    rough.addColorStop(1, "rgba(17, 188, 233, 0)");
    context.fillStyle = rough;
    context.fillRect(bounds.minX, bounds.minY, width, height);
  }

  context.lineWidth = 1.4 * (window.devicePixelRatio || 1);
  context.strokeStyle = "rgba(255, 255, 255, 0.82)";
  tracePolygonPath(context, polygons);
  context.stroke();
  context.restore();
}

function drawLakeParticles(context, polygons, bounds, frame, dpr, timestamp) {
  const speed = Number(frame?.wind_speed_mph || 0);
  const bearing = flowBearing(frame);
  const radians = bearing * Math.PI / 180;
  const elapsed = Math.min(0.05, Math.max(0.01, (timestamp - lastParticleFrame) / 1000 || 0.016));
  const particleCount = Math.max(42, Math.min(180, Math.round((bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY) / 9000)));
  const pixelsPerSecond = (12 + speed * 3.2) * dpr;
  const dx = Math.sin(radians) * pixelsPerSecond * elapsed;
  const dy = -Math.cos(radians) * pixelsPerSecond * elapsed;
  const tail = (8 + speed * 1.1) * dpr;

  while (lakeSurfaceParticles.length < particleCount) {
    lakeSurfaceParticles.push(randomLakePoint(bounds, polygons));
  }
  if (lakeSurfaceParticles.length > particleCount) {
    lakeSurfaceParticles.length = particleCount;
  }

  context.save();
  tracePolygonPath(context, polygons);
  context.clip("evenodd");
  context.lineCap = "round";
  context.lineWidth = Math.max(1, 1.4 * dpr);

  for (const particle of lakeSurfaceParticles) {
    particle.x += dx;
    particle.y += dy;
    particle.phase += elapsed * Math.max(1, speed * 0.18);
    if (!pointInLake(particle, polygons)) {
      Object.assign(particle, randomLakePoint(bounds, polygons));
    }
    const shimmer = 0.42 + Math.sin(particle.phase) * 0.18;
    context.strokeStyle = `rgba(255, 255, 255, ${Math.max(0.24, shimmer)})`;
    context.beginPath();
    context.moveTo(particle.x - Math.sin(radians) * tail, particle.y + Math.cos(radians) * tail);
    context.lineTo(particle.x, particle.y);
    context.stroke();
  }
  context.restore();
}

function drawLakeSurfaceOverlay(timestamp = performance.now()) {
  if (!lakeSurfaceCanvas || !lakeSurfaceContext || !lakeMap) return;
  const dpr = resizeLakeSurfaceCanvas();
  const context = lakeSurfaceContext;
  context.clearRect(0, 0, lakeSurfaceCanvas.width, lakeSurfaceCanvas.height);

  if (activeMapMode !== "boating" || !lakeSurfaceRings.length) {
    lakeSurfaceCanvas.hidden = activeMapMode !== "boating";
    lastParticleFrame = timestamp;
    return;
  }
  lakeSurfaceCanvas.hidden = false;
  const polygons = projectedLakePolygons(dpr);
  const bounds = polygonBounds(polygons);
  if (!Number.isFinite(bounds.minX) || bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) return;

  const frame = windFrames[windFrameIndex] || {};
  const speed = Number(frame.wind_speed_mph || 0);
  drawLakeGradient(context, polygons, bounds, speed);
  drawLakeParticles(context, polygons, bounds, frame, dpr, timestamp);
  lastParticleFrame = timestamp;
}

function startLakeSurfaceAnimation() {
  if (lakeSurfaceAnimation) return;
  const tick = (timestamp) => {
    drawLakeSurfaceOverlay(timestamp);
    lakeSurfaceAnimation = window.requestAnimationFrame(tick);
  };
  lakeSurfaceAnimation = window.requestAnimationFrame(tick);
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
    drawLakeSurfaceOverlay(performance.now());
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
  loadLakeShoreline(spot);

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
    note.textContent = "Boating Areas mode: Valley County's 300 ft no-wake zone is grey. The water just beyond that zone is highlighted as a preferred Payette band, especially when wind or boat traffic makes the middle choppier. Verified danger restrictions are still pending.";
    if (sources) {
      sources.innerHTML = 'Sources: <a href="https://mccallgis.mccall.id.us/mcgis/rest/services/PUB/Payette_Lake_Bathymetry_Contours/FeatureServer/info/iteminfo" target="_blank" rel="noopener">McCall GIS bathymetry</a> and <a href="https://services6.arcgis.com/ikurHvtarxfN6u3u/arcgis/rest/services/WATERWAYS_ORDINANCE/FeatureServer" target="_blank" rel="noopener">Valley County waterways ordinance</a>.';
    }
  } else {
    note.textContent = "Boating Areas mode: lake surface is colored from the selected wind hour. Low wind stays mostly blue; breezier hours turn the exposed middle pink while edges stay blue. Tahoe depth and verified danger layers still need sources.";
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
  if (lakeSurfaceCanvas) lakeSurfaceCanvas.hidden = !isBoating;
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
        "fill-color": "#8c95a3",
        "fill-opacity": 0.56,
      },
    });
    lakeMap.addLayer({
      id: "payette-no-wake-line",
      type: "line",
      source: "payette-no-wake",
      paint: {
        "line-color": "#64748b",
        "line-width": 2.4,
      },
    });
    lakeMap.addLayer({
      id: "payette-setback-line",
      type: "line",
      source: "payette-setback",
      paint: {
        "line-color": "#12bcea",
        "line-width": 4,
        "line-opacity": 0.95,
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
  ensureLakeSurfaceCanvas();
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
