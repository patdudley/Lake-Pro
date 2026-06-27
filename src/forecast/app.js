import { lakeSpots } from "../spots/index.js";
import { windFrameForSpot } from "../map/windFrameSource.js";

let lakeMap = null;
let currentSpot = null;
let windFrames = [];
let windFrameIndex = 0;
let windTimer = null;
let windProbeMarker = null;
let windProbeElement = null;
let lakeSurfaceCanvas = null;
let lakeSurfaceContext = null;
let lakeSurfaceRings = [];
let lakeSurfaceParticles = [];
let lakeSurfaceAnimation = null;
let lastParticleFrame = 0;
let loadedShorelineSlug = "";
let currentLiveLatest = null;
const liveSpotBundles = new Map();

const mapLayerUrls = {
  payetteBathymetry: "data/live/map_layers/payette_bathymetry_contours.geojson",
  payetteNoWake: "data/live/map_layers/payette_no_wake_zone.geojson",
  payetteSetback: "data/live/map_layers/payette_shoreline_setback.geojson",
  shorelines: {
    "lake-tahoe": "data/live/map_layers/lake-tahoe_shoreline.geojson",
    "payette-lake": "data/live/map_layers/payette-lake_shoreline.geojson",
  },
};

const mapViewBounds = {
  "lake-tahoe": [-120.1639382, 38.9281733, -119.9260578, 39.2490133],
  "payette-lake": [-116.1257363, 44.9109906, -116.0513211, 44.9947051],
};

const defaultSpotSlug = "payette-lake";
const DAYLIGHT_START_HOUR = 6;
const DAYLIGHT_END_HOUR = 20;

const cameraBySpot = {
  "lake-tahoe": {
    title: "Live Lake View",
    description: "Current South Lake Tahoe shoreline view",
    sourceUrl: "https://edgewoodtahoe.com/webcam/",
    imageUrl: "assets/edgewood-tahoe-camera.png",
    alt: "Edgewood Tahoe webcam screenshot over Lake Tahoe",
  },
  "payette-lake": {
    title: "Live Lake View",
    description: "Current Payette Lake marina view",
    sourceUrl: "https://milehighmarina.com/webcams/",
    imageUrl: "assets/mile-high-marina-camera.png",
    alt: "Mile High Marina webcam screenshot over Payette Lake",
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
  const value = new Date(`${date}T12:00:00`);
  if (Number.isNaN(value.getTime())) return index === 0 ? "Today" : "";
  const dayNumber = value.toLocaleDateString("en-US", { day: "numeric" });
  if (index === 0) return `Today ${dayNumber}`;
  const weekday = value.toLocaleDateString("en-US", { weekday: "short" });
  return `${weekday} ${dayNumber}`;
}

function weatherIconClass(day = {}) {
  const value = Number(day.weather_code);
  const precip = Number(day.precipitation_probability_max ?? 0);
  const high = Number(day.temperature_2m_max ?? 0);

  if ((value >= 95) || precip >= 75) return "weather-storm";
  if ((value >= 71 && value <= 77) || value === 85 || value === 86) return "weather-snow";
  if ((value >= 51 && value <= 67) || (value >= 80 && value <= 82) || precip >= 45) return "weather-rain";
  if (value === 0 || (precip <= 10 && high >= 70)) return "weather-sun";
  if (value === 1 || value === 2 || (value === 3 && precip < 25)) return "weather-partly";
  if (value === 3 || value === 45 || value === 48) return "weather-cloud";
  return "weather-cloud";
}

function forecastDetail(day) {
  if (day.best_window_wind_mph != null) {
    return `${day.best_window_wind_mph} mph`;
  }
  if (day.chop_proxy_ft != null) return `${day.chop_proxy_ft} ft chop`;
  return day.summary || "Stubbed";
}

function gradeDescription(grade) {
  if (grade === "A") return "Epic";
  if (grade === "B") return "Fair";
  if (grade === "C") return "Below average";
  if (grade === "D") return "Poor";
  if (grade === "F") return "Avoid";
  return "Pending";
}

function formatWind(latest = {}) {
  const wind = latest.wind_speed_max_mph;
  const direction = latest.wind_direction_label;
  if (wind == null) return "Wind pending";
  return `${Math.round(Number(wind))} mph${direction ? ` ${direction}` : ""}`;
}

function formatChop(latest = {}) {
  if (latest.chop_proxy_ft == null) return "Chop pending";
  return `${latest.chop_proxy_ft} ft chop`;
}

function formatBestWindow(latest = {}) {
  if (latest.best_window && latest.best_window !== "Pending") return latest.best_window;
  if (latest.best_window_wind_mph != null) return `${latest.best_window_wind_mph} mph best window`;
  return "Best daylight window pending";
}

function renderLakeSnapshotSlider() {
  const slider = document.getElementById("lakeSnapshotSlider");
  if (!slider) return;
  const orderedSpots = currentSpot ? [currentSpot] : lakeSpots.slice(0, 1);
  slider.replaceChildren(...orderedSpots.map((spot) => {
    const bundle = liveSpotBundles.get(spot.slug);
    const latest = bundle?.latest || {};
    const grade = gradeValue(latest.grade);
    const card = document.createElement("button");
    card.className = "lake-snapshot-card";
    card.type = "button";
    card.dataset.spot = spot.slug;
    card.dataset.active = spot.slug === currentSpot?.slug ? "true" : "false";
    card.setAttribute("aria-pressed", spot.slug === currentSpot?.slug ? "true" : "false");
    card.innerHTML = `
      <span class="snapshot-location">${spot.location}</span>
      <strong>${spot.name}</strong>
      <span class="snapshot-grade grade-letter" data-grade="${grade}">${latest.grade || "--"}</span>
      <span class="snapshot-grade-label">${gradeDescription(latest.grade)}</span>
      <span class="snapshot-track" aria-hidden="true"><i style="width: ${latest.score == null ? 22 : Math.max(6, Math.min(100, latest.score))}%"></i></span>
      <span class="snapshot-metrics">
        <span><b>Wind</b>${formatWind(latest)}</span>
        <span><b>Surface</b>${formatChop(latest)}</span>
        <span><b>Window</b>${formatBestWindow(latest)}</span>
      </span>
    `;
    card.addEventListener("click", () => selectSpotBySlug(spot.slug));
    return card;
  }));
}

function temperatureRange(day) {
  if (day.temperature_2m_max == null || day.temperature_2m_min == null) return "";
  return `<span class="forecast-temps">${Math.round(day.temperature_2m_max)}&deg; <small>${Math.round(day.temperature_2m_min)}&deg;</small></span>`;
}

function gradeValue(grade) {
  return ["A", "B", "C", "D", "F"].includes(grade) ? grade : "";
}

function gradeFromScore(score) {
  if (score >= 85) return "A";
  if (score >= 72) return "B";
  if (score >= 60) return "C";
  if (score >= 48) return "D";
  return "F";
}

function topScoreForGrade(grade) {
  if (grade === "A") return 100;
  if (grade === "B") return 84;
  if (grade === "C") return 71;
  if (grade === "D") return 59;
  return 47;
}

function windGradeCap(speed) {
  const wind = Number(speed);
  if (!Number.isFinite(wind)) return "A";
  if (wind >= 24) return "F";
  if (wind >= 16) return "D";
  if (wind >= 12) return "C";
  if (wind >= 8) return "C";
  if (wind >= 5) return "B";
  return "A";
}

function chopProxyFt(windSpeed, gustSpeed = windSpeed) {
  const wind = Number(windSpeed);
  if (!Number.isFinite(wind)) return null;
  const gust = Number.isFinite(Number(gustSpeed)) ? Number(gustSpeed) : wind;
  return Math.round(Math.max(0, (wind - 4) * 0.055 + Math.max(0, gust - wind) * 0.025) * 10) / 10;
}

function windAdjustedLatest(latest = {}, frame = windFrames[windFrameIndex]) {
  const speed = Number(frame?.wind_speed_mph ?? latest.best_window_wind_mph ?? latest.wind_speed_max_mph);
  const scoreBeforeWindCap = latest.score_before_wind_cap ?? latest.score;
  const baseScore = Number.isFinite(Number(scoreBeforeWindCap)) ? Number(scoreBeforeWindCap) : null;
  const cap = windGradeCap(speed);
  let score = baseScore == null ? null : Math.min(baseScore, topScoreForGrade(cap));
  if (score != null && cap === "D" && speed < 24) {
    score = Math.max(score, topScoreForGrade("F") + 1);
  }
  const grade = score == null ? latest.grade || "--" : gradeFromScore(score);
  return {
    ...latest,
    grade,
    score,
    chop_proxy_ft: Number.isFinite(speed) ? chopProxyFt(speed) : latest.chop_proxy_ft,
  };
}

function renderCondition(latest = currentLiveLatest, frame = windFrames[windFrameIndex]) {
  if (!latest) return;
  const adjusted = windAdjustedLatest(latest, frame);
  const grade = document.getElementById("conditionGrade");
  grade.textContent = adjusted.grade || "--";
  grade.dataset.grade = gradeValue(adjusted.grade);
  const summary = document.getElementById("conditionSummary");
  if (summary) {
    summary.textContent = adjusted.chop_proxy_ft != null
      ? `${adjusted.chop_proxy_ft} ft chop`
      : "Rating pending";
  }
  const fill = document.getElementById("scoreFill");
  if (fill && adjusted.score != null) fill.style.width = `${Math.max(6, Math.min(100, adjusted.score))}%`;
}

function renderForecastStrip(days = placeholderForecast) {
  const strip = document.getElementById("forecastStrip");
  strip.replaceChildren(...days.map((day, index) => {
    const card = document.createElement("article");
    card.className = "forecast-day";
    const grade = gradeValue(day.grade);
    card.innerHTML = `
      <span>${day.label || dayLabel(day.date, index)}</span>
      <i class="weather-icon ${weatherIconClass(day)}" aria-hidden="true"></i>
      ${temperatureRange(day)}
      <strong class="grade-letter" data-grade="${grade}">${day.grade || "--"}</strong>
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
  return lakeSpots.find((spot) => spot.slug === params.get("spot"))
    || lakeSpots.find((spot) => spot.slug === defaultSpotSlug)
    || lakeSpots[0];
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
    selectSpotBySlug(select.value);
  });
}

function selectSpotBySlug(slug) {
  const nextSpot = lakeSpots.find((spot) => spot.slug === slug)
    || lakeSpots.find((spot) => spot.slug === defaultSpotSlug)
    || lakeSpots[0];
  const url = new URL(window.location.href);
  url.searchParams.set("spot", nextSpot.slug);
  window.history.replaceState({}, "", url);
  const select = document.getElementById("spotSelect");
  if (select) select.value = nextSpot.slug;
  renderSpot(nextSpot);
  updateMapForSpot(nextSpot);
  renderLakeSnapshotSlider();
}

function renderSpot(spot) {
  currentSpot = spot;
  currentLiveLatest = null;
  document.getElementById("spotName").textContent = spot.name;
  document.getElementById("spotLocation").textContent = spot.location;
  renderCameraCard(spot);
  loadLiveSpotData(spot);
  loadWindTimelapse(spot);
  loadLakeShoreline(spot);
}

function renderCameraCard(spot) {
  const camera = cameraBySpot[spot.slug];
  const cameraCard = document.getElementById("cameraCard");
  if (!cameraCard) return;
  cameraCard.hidden = !camera;
  if (!camera) return;
  document.getElementById("cameraTitle").textContent = camera.title;
  document.getElementById("cameraDescription").textContent = camera.description;
  const overlay = document.getElementById("cameraLocationOverlay");
  if (overlay) overlay.textContent = `${spot.name}, ${spot.location}`;
  const source = document.getElementById("cameraSource");
  source.href = camera.sourceUrl;
  const image = document.getElementById("cameraImage");
  image.src = camera.imageUrl;
  image.alt = camera.alt;
}

function renderLiveSpotData(bundle) {
  const latest = bundle.latest || {};
  if (currentSpot) liveSpotBundles.set(currentSpot.slug, bundle);
  currentLiveLatest = latest;
  renderCondition(latest);
  renderForecastStrip(bundle.ten_day || []);
  renderLakeSnapshotSlider();
}

async function loadLiveSpotData(spot) {
  try {
    const bundle = await fetchJson(`data/live/spots/${spot.slug}.json`);
    liveSpotBundles.set(spot.slug, bundle);
    if (currentSpot?.slug !== spot.slug) {
      renderLakeSnapshotSlider();
      return;
    }
    renderLiveSpotData(bundle);
  } catch (error) {
    console.warn("[LakePro] Live spot data unavailable", error);
    const grade = document.getElementById("conditionGrade");
    grade.textContent = "--";
    grade.dataset.grade = "";
    const summary = document.getElementById("conditionSummary");
    if (summary) summary.textContent = "Rating pending";
    currentLiveLatest = null;
    renderForecastStrip();
    renderLakeSnapshotSlider();
  }
}

async function loadLakeSnapshotData() {
  const results = await Promise.allSettled(lakeSpots.map(async (spot) => {
    if (liveSpotBundles.has(spot.slug)) return;
    const bundle = await fetchJson(`data/live/spots/${spot.slug}.json`);
    liveSpotBundles.set(spot.slug, bundle);
  }));
  if (results.some((result) => result.status === "rejected")) {
    console.warn("[LakePro] One or more live lake cards could not load", results);
  }
  renderLakeSnapshotSlider();
}

function flowBearing(frame) {
  const fromDirection = Number(frame?.wind_direction_deg);
  if (!Number.isFinite(fromDirection)) return 0;
  return (fromDirection + 180) % 360;
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

function frameDateKey(time) {
  if (!time) return "";
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function nightOverlayOpacity(time) {
  if (!time) return 0;
  const match = String(time).match(/T(\d{2}):(\d{2})/);
  const date = new Date(time);
  if (!match && Number.isNaN(date.getTime())) return 0;
  const hour = match
    ? Number(match[1]) + Number(match[2]) / 60
    : date.getHours() + date.getMinutes() / 60;
  if (hour >= DAYLIGHT_START_HOUR + 1 && hour <= DAYLIGHT_END_HOUR - 1) return 0;
  if (hour < DAYLIGHT_START_HOUR || hour > DAYLIGHT_END_HOUR) return 0.42;
  if (hour < DAYLIGHT_START_HOUR + 1) return (DAYLIGHT_START_HOUR + 1 - hour) * 0.42;
  return (hour - (DAYLIGHT_END_HOUR - 1)) * 0.42;
}

function applyNightOverlay(context, frame) {
  const opacity = nightOverlayOpacity(frame?.time);
  const mapPanel = document.querySelector(".map-panel");
  if (mapPanel) {
    mapPanel.classList.toggle("is-night-frame", opacity > 0.08);
    mapPanel.style.setProperty("--night-opacity", opacity.toFixed(3));
  }
  if (!opacity || !lakeSurfaceCanvas) return;
  context.save();
  context.globalCompositeOperation = "source-over";
  context.fillStyle = `rgba(4, 12, 42, ${opacity})`;
  context.fillRect(0, 0, lakeSurfaceCanvas.width, lakeSurfaceCanvas.height);
  context.restore();
}

function createWindProbeElement() {
  const probe = document.createElement("button");
  probe.className = "wind-probe";
  probe.type = "button";
  probe.setAttribute("aria-label", "Wind probe. Drag to inspect wind at a lake spot.");
  probe.innerHTML = `
    <span class="wind-probe-value">-- mph</span>
    <span class="wind-probe-arrow" aria-hidden="true"></span>
    <i aria-hidden="true"></i>
  `;
  return probe;
}

function updateWindProbe(frame = windFrames[windFrameIndex]) {
  if (!windProbeElement) return;
  const value = windProbeElement.querySelector(".wind-probe-value");
  const arrow = windProbeElement.querySelector(".wind-probe-arrow");
  const speed = Math.round(Number(frame?.wind_speed_mph || 0));
  const label = frame?.wind_direction_label || "";
  if (value) value.textContent = `${speed} mph`;
  if (arrow) arrow.style.transform = `rotate(${flowBearing(frame) - 90}deg)`;
  windProbeElement.setAttribute("aria-label", `Wind probe showing ${speed} mph ${label}. Drag to inspect another lake spot.`);
}

function ensureWindProbeMarker() {
  if (!lakeMap || windProbeMarker || !currentSpot) return;
  windProbeElement = createWindProbeElement();
  windProbeMarker = new window.maplibregl.Marker({
    element: windProbeElement,
    anchor: "bottom",
    draggable: true,
  })
    .setLngLat([currentSpot.longitude, currentSpot.latitude])
    .addTo(lakeMap);
  updateWindProbe();
}

function resetWindProbeForSpot(spot) {
  ensureWindProbeMarker();
  if (windProbeMarker && spot) {
    windProbeMarker.setLngLat([spot.longitude, spot.latitude]);
    updateWindProbe();
  }
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

function lakeGradientCenters(bounds, spot) {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const defaultCenter = { x: bounds.minX + width * 0.5, y: bounds.minY + height * 0.5 };
  if (spot?.slug === "payette-lake") {
    return [
      { x: bounds.minX + width * 0.36, y: bounds.minY + height * 0.68, radius: Math.max(width, height) * 0.44 },
      { x: bounds.minX + width * 0.33, y: bounds.minY + height * 0.82, radius: Math.max(width, height) * 0.3 },
      { x: bounds.minX + width * 0.63, y: bounds.minY + height * 0.34, radius: Math.max(width, height) * 0.4 },
    ];
  }
  if (spot?.slug === "lake-tahoe") {
    return [
      { x: bounds.minX + width * 0.52, y: bounds.minY + height * 0.5, radius: Math.max(width, height) * 0.43 },
    ];
  }
  return [{ ...defaultCenter, radius: Math.max(width, height) * 0.44 }];
}

function lakeProtectionCenters(bounds, spot) {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  if (spot?.slug === "lake-tahoe") {
    return [
      { x: bounds.minX + width * 0.45, y: bounds.minY + height * 0.24, radius: Math.max(width, height) * 0.22, strength: 0.2 },
      { x: bounds.minX + width * 0.36, y: bounds.minY + height * 0.5, radius: Math.max(width, height) * 0.24, strength: 0.18 },
      { x: bounds.minX + width * 0.56, y: bounds.minY + height * 0.74, radius: Math.max(width, height) * 0.23, strength: 0.16 },
    ];
  }
  if (spot?.slug !== "payette-lake") return [];
  return [
    { x: bounds.minX + width * 0.52, y: bounds.minY + height * 0.47, radius: Math.max(width, height) * 0.24, strength: 0.3 },
    { x: bounds.minX + width * 0.72, y: bounds.minY + height * 0.62, radius: Math.max(width, height) * 0.3, strength: 0.26 },
    { x: bounds.minX + width * 0.58, y: bounds.minY + height * 0.55, radius: Math.max(width, height) * 0.21, strength: 0.23 },
  ];
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

function drawLakeGradient(context, polygons, bounds, frame, spot) {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const speed = Number(frame?.wind_speed_mph || 0);
  const exposure = Math.max(0, Math.min(1, (speed - 5.5) / 6));
  const roughWind = Math.max(0, Math.min(1, (speed - 12) / 10));
  const dangerousWind = Math.max(0, Math.min(1, (speed - 24) / 8));
  const bearing = flowBearing(frame);
  const radians = bearing * Math.PI / 180;
  const fetchOffset = Math.min(0.18, speed * 0.012);
  const centers = lakeGradientCenters(bounds, spot);
  const protectedCenters = lakeProtectionCenters(bounds, spot);

  context.save();
  tracePolygonPath(context, polygons);
  context.clip("evenodd");

  const base = context.createLinearGradient(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
  if (roughWind > 0.01) {
    base.addColorStop(0, `rgba(50, 112, 226, ${0.92 + roughWind * 0.02})`);
    base.addColorStop(0.48, `rgba(104, 82, 225, ${0.88 + roughWind * 0.04})`);
    base.addColorStop(1, `rgba(168, 55, 220, ${0.74 + roughWind * 0.08 + dangerousWind * 0.1})`);
  } else {
    base.addColorStop(0, "rgba(24, 157, 232, 0.96)");
    base.addColorStop(0.52, "rgba(28, 116, 235, 0.94)");
    base.addColorStop(1, "rgba(25, 90, 220, 0.9)");
  }
  context.fillStyle = base;
  context.fillRect(bounds.minX, bounds.minY, width, height);

  if (exposure > 0.03) {
    const windWash = context.createLinearGradient(
      bounds.minX - Math.sin(radians) * width * 0.2,
      bounds.minY + Math.cos(radians) * height * 0.2,
      bounds.maxX + Math.sin(radians) * width * 0.2,
      bounds.maxY - Math.cos(radians) * height * 0.2
    );
    windWash.addColorStop(0, `rgba(94, 76, 225, ${0.12 * exposure + 0.14 * roughWind + 0.1 * dangerousWind})`);
    windWash.addColorStop(0.46, `rgba(148, 54, 222, ${0.26 * exposure + 0.16 * roughWind + 0.14 * dangerousWind})`);
    windWash.addColorStop(1, `rgba(242, 11, 198, ${0.26 * exposure + 0.18 * roughWind + 0.24 * dangerousWind})`);
    context.fillStyle = windWash;
    context.fillRect(bounds.minX, bounds.minY, width, height);

    for (const center of centers) {
      const exposedX = center.x + Math.sin(radians) * width * fetchOffset;
      const exposedY = center.y - Math.cos(radians) * height * fetchOffset;
      const rough = context.createRadialGradient(exposedX, exposedY, center.radius * 0.08, exposedX, exposedY, center.radius);
      rough.addColorStop(0, `rgba(242, 11, 198, ${0.5 * exposure + 0.22 * roughWind + 0.22 * dangerousWind})`);
      rough.addColorStop(0.34, `rgba(211, 45, 220, ${0.42 * exposure + 0.18 * roughWind + 0.18 * dangerousWind})`);
      rough.addColorStop(0.68, `rgba(116, 74, 225, ${0.28 * exposure + 0.13 * roughWind + 0.12 * dangerousWind})`);
      rough.addColorStop(0.92, `rgba(74, 96, 226, ${0.08 * exposure * (1 - dangerousWind)})`);
      rough.addColorStop(1, "rgba(18, 202, 234, 0)");
      context.fillStyle = rough;
      context.fillRect(bounds.minX, bounds.minY, width, height);
    }

    for (const center of protectedCenters) {
      const calm = context.createRadialGradient(center.x, center.y, center.radius * 0.08, center.x, center.y, center.radius);
      const calmStrength = center.strength * (1 - exposure * 0.32) * (1 - roughWind * 0.36) * (1 - dangerousWind * 0.78);
      calm.addColorStop(0, `rgba(50, 110, 226, ${calmStrength})`);
      calm.addColorStop(0.5, `rgba(75, 96, 222, ${calmStrength * 0.5})`);
      calm.addColorStop(0.84, `rgba(112, 82, 220, ${calmStrength * 0.18})`);
      calm.addColorStop(1, "rgba(44, 105, 225, 0)");
      context.fillStyle = calm;
      context.fillRect(bounds.minX, bounds.minY, width, height);
    }
  }

  const shoreGlow = context.createRadialGradient(
    bounds.minX + width * 0.5,
    bounds.minY + height * 0.5,
    Math.max(width, height) * 0.24,
    bounds.minX + width * 0.5,
    bounds.minY + height * 0.5,
    Math.max(width, height) * 0.76
  );
  const payette = spot?.slug === "payette-lake";
  shoreGlow.addColorStop(0, "rgba(18, 202, 234, 0)");
  shoreGlow.addColorStop(0.6, `rgba(63, 107, 228, ${(payette ? 0.025 + exposure * 0.015 : 0.08 + exposure * 0.05) * (1 - roughWind * 0.34) * (1 - dangerousWind * 0.65)})`);
  shoreGlow.addColorStop(0.84, `rgba(75, 98, 226, ${(payette ? 0.07 + exposure * 0.025 : 0.2 + exposure * 0.06) * (1 - roughWind * 0.38) * (1 - dangerousWind * 0.72)})`);
  shoreGlow.addColorStop(1, `rgba(117, 76, 222, ${(payette ? 0.11 + exposure * 0.03 : 0.32 + exposure * 0.07) * (1 - roughWind * 0.44) * (1 - dangerousWind * 0.8)})`);
  context.fillStyle = shoreGlow;
  context.fillRect(bounds.minX, bounds.minY, width, height);

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

  if (!lakeSurfaceRings.length) {
    lakeSurfaceCanvas.hidden = true;
    lastParticleFrame = timestamp;
    return;
  }
  lakeSurfaceCanvas.hidden = false;
  const polygons = projectedLakePolygons(dpr);
  const bounds = polygonBounds(polygons);
  if (!Number.isFinite(bounds.minX) || bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) return;

  const frame = windFrames[windFrameIndex] || {};
  drawLakeGradient(context, polygons, bounds, frame, currentSpot);
  drawLakeParticles(context, polygons, bounds, frame, dpr, timestamp);
  applyNightOverlay(context, frame);
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
  const backButton = document.getElementById("windBackButton");
  const forwardButton = document.getElementById("windForwardButton");
  if (slider) {
    slider.max = String(Math.max(0, windFrames.length - 1));
    slider.value = String(windFrameIndex);
  }
  if (backButton) {
    const currentDay = frameDateKey(windFrames[0]?.time);
    const selectedDay = frameDateKey(frame?.time);
    const isFutureDay = Boolean(currentDay && selectedDay && selectedDay !== currentDay);
    backButton.closest(".timelapse-control")?.classList.toggle("has-back", isFutureDay);
    backButton.hidden = !isFutureDay;
    backButton.disabled = !isFutureDay || windFrames.length < 2;
  }
  if (forwardButton) forwardButton.disabled = windFrameIndex >= windFrames.length - 1 || windFrames.length < 2;

  if (!frame || !currentSpot) {
    if (label) label.textContent = "Wind timeline pending";
    return;
  }

  if (label) {
    label.textContent = `${formatFrameTime(frame.time)} · ${Math.round(frame.wind_speed_mph || 0)} mph ${frame.wind_direction_label || ""}`.trim();
  }
  renderCondition(currentLiveLatest, frame);

  if (lakeMap) {
    ensureWindProbeMarker();
    updateWindProbe(frame);
    drawLakeSurfaceOverlay(performance.now());
  }
}

function stopWindTimelapse() {
  if (windTimer) {
    window.clearInterval(windTimer);
    windTimer = null;
  }
  const button = document.getElementById("windPlayButton");
  if (button) {
    button.classList.remove("is-playing");
    button.setAttribute("aria-label", "Play wind timeline");
    button.setAttribute("aria-pressed", "false");
  }
}

function startWindTimelapse() {
  if (windTimer || windFrames.length < 2) return;
  const button = document.getElementById("windPlayButton");
  if (button) {
    button.classList.add("is-playing");
    button.setAttribute("aria-label", "Pause wind timeline");
    button.setAttribute("aria-pressed", "true");
  }
  windTimer = window.setInterval(() => {
    renderWindFrame((windFrameIndex + 1) % windFrames.length);
  }, 850);
}

function renderTimelapseControls() {
  const slider = document.getElementById("windFrameSlider");
  const button = document.getElementById("windPlayButton");
  const backButton = document.getElementById("windBackButton");
  const forwardButton = document.getElementById("windForwardButton");
  const dayStep = 24;
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
  if (backButton) {
    backButton.onclick = () => {
      stopWindTimelapse();
      renderWindFrame(windFrameIndex - dayStep);
    };
  }
  if (forwardButton) {
    forwardButton.onclick = () => {
      stopWindTimelapse();
      renderWindFrame(windFrameIndex + dayStep);
    };
  }
  renderWindFrame(currentWindFrameIndex());
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

function currentWindFrameIndex(now = new Date()) {
  if (!windFrames.length) return 0;
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return 0;
  const firstFutureIndex = windFrames.findIndex((frame) => {
    const timeMs = new Date(frame.time).getTime();
    return Number.isFinite(timeMs) && timeMs >= nowMs;
  });
  return firstFutureIndex >= 0 ? firstFutureIndex : windFrames.length - 1;
}

function updateMapForSpot(spot) {
  loadLakeShoreline(spot);
  setPayetteBoatingLayerVisibility(spot.slug === "payette-lake");

  if (!lakeMap) return;

  fitMapToSpot(spot);

  resetWindProbeForSpot(spot);
  renderWindFrame(windFrameIndex);
}

function fitMapPadding() {
  const narrow = window.matchMedia("(max-width: 820px)").matches;
  return narrow
    ? { top: 24, right: 24, bottom: 82, left: 24 }
    : { top: 34, right: 42, bottom: 96, left: 42 };
}

function fitMapToSpot(spot, duration = 650) {
  if (!lakeMap || !spot) return;
  const source = windFrameForSpot(spot);
  const bounds = mapViewBounds[spot.slug] || source?.bounds;
  if (!bounds) {
    lakeMap.easeTo({
      center: [spot.longitude, spot.latitude],
      zoom: spot.slug === "lake-tahoe" ? 8.35 : 11.15,
      duration,
      essential: true,
    });
    return;
  }

  const [west, south, east, north] = bounds;
  lakeMap.fitBounds([[west, south], [east, north]], {
    padding: fitMapPadding(),
    duration,
    essential: true,
  });
}

function setLayerVisibility(ids, visible) {
  if (!lakeMap) return;
  ids.forEach((id) => {
    if (lakeMap.getLayer(id)) {
      lakeMap.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
  });
}

function setPayetteBoatingLayerVisibility(visible) {
  setLayerVisibility(["bathymetry-contours", "payette-no-wake-fill", "payette-no-wake-line", "payette-setback-line"], visible);
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
  fitMapToSpot(currentSpot, 0);
  renderWindFrame(windFrameIndex);
}

function initMap(activeSpot) {
  if (!window.maplibregl) {
    console.warn("[LakePro] Map library unavailable");
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
    attributionControl: false,
  });

  lakeMap.addControl(new window.maplibregl.AttributionControl({ compact: true }), "top-left");
  lakeMap.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), "top-right");
  ensureLakeSurfaceCanvas();
  requestAnimationFrame(resizeMapToPanel);
  window.setTimeout(resizeMapToPanel, 250);
  window.setTimeout(resizeMapToPanel, 1000);
  window.addEventListener("resize", resizeMapToPanel);
  lakeMap.on("click", (event) => {
    ensureWindProbeMarker();
    if (windProbeMarker) windProbeMarker.setLngLat(event.lngLat);
  });
  lakeMap.once("load", () => {
    addPayetteBoatingLayers().finally(() => {
      resizeMapToPanel();
      setPayetteBoatingLayerVisibility(currentSpot?.slug === "payette-lake");
      resetWindProbeForSpot(currentSpot);
      renderWindFrame(windFrameIndex);
    });
  });
}

const activeSpot = selectedSpot();
renderSpotSwitcher(activeSpot);
renderSpot(activeSpot);
renderLakeSnapshotSlider();
loadLakeSnapshotData();
initMap(activeSpot);
