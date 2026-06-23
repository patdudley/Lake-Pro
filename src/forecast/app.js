import { lakeSpots } from "../spots/index.js";

let lakeMap = null;
let currentSpot = null;
let windFrames = [];
let windFrameIndex = 0;
let windTimer = null;
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
    return `${day.best_window_wind_mph} mph best window`;
  }
  if (day.chop_proxy_ft != null) return `${day.chop_proxy_ft} ft chop proxy`;
  return day.summary || "Stubbed";
}

function temperatureRange(day) {
  if (day.temperature_2m_max == null || day.temperature_2m_min == null) return "";
  return `<span class="forecast-temps">${Math.round(day.temperature_2m_max)}&deg; <small>${Math.round(day.temperature_2m_min)}&deg;</small></span>`;
}

function gradeValue(grade) {
  return ["A", "B", "C", "D", "F"].includes(grade) ? grade : "";
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
  const cameraCard = document.getElementById("cameraCard");
  if (cameraCard) cameraCard.hidden = spot.slug !== "payette-lake";
  loadLiveSpotData(spot);
  loadWindTimelapse(spot);
  loadLakeShoreline(spot);
}

function windIntensity(speed) {
  const value = Number(speed) || 0;
  if (value <= 5) return 0;
  return Math.max(0, Math.min(1, (value - 5) / 7));
}

function hourLabel(time) {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-US", { hour: "numeric" }).replace(" ", "").toLowerCase();
}

function renderWindChart(hourly = {}) {
  const chart = document.querySelector(".wind-placeholder");
  if (!chart) return;
  const times = hourly.time || [];
  const speeds = hourly.wind_speed_10m || [];
  const firstDay = frameDateKey(times[0]);
  const points = times
    .map((time, index) => ({ time, speed: Number(speeds[index] ?? 0) }))
    .filter((point) => frameDateKey(point.time) === firstDay)
    .slice(0, 24);
  if (!points.length) {
    chart.innerHTML = "<span>Wind pending</span>";
    return;
  }
  const maxWind = Math.max(8, ...points.map((point) => point.speed));
  const peak = Math.max(...points.map((point) => point.speed));
  const peakIndex = points.findIndex((point) => point.speed === peak);
  chart.innerHTML = `
    <div class="wind-chart">
      <div class="wind-chart-summary">
        <strong>${new Date(points[0].time).toLocaleDateString("en-US", { weekday: "long" })}</strong>
        <span>Peak ${Math.round(peak)} mph</span>
      </div>
      <div class="wind-bars" style="--max-wind:${maxWind}; grid-template-columns:repeat(${points.length}, minmax(18px, 1fr))">
        ${points.map((point, index) => {
          const height = Math.max(10, Math.round((point.speed / maxWind) * 100));
          const intensity = windIntensity(point.speed).toFixed(2);
          const showValue = index === 0 || index === peakIndex || index === points.length - 1;
          const showTime = index === 0 || index === points.length - 1 || index % 2 === 0;
          return `
            <div class="wind-bar-column" title="${hourLabel(point.time)} ${Math.round(point.speed)} mph" style="--wind-intensity:${intensity}; --bar-height:${height}%">
              <span>${showValue ? `${Math.round(point.speed)}` : ""}</span>
              <i aria-hidden="true"></i>
              <em>${showTime ? hourLabel(point.time) : ""}</em>
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

function renderLiveSpotData(bundle) {
  const latest = bundle.latest || {};
  const grade = document.getElementById("conditionGrade");
  grade.textContent = latest.grade || "--";
  grade.dataset.grade = gradeValue(latest.grade);
  document.getElementById("conditionSummary").textContent = latest.chop_proxy_ft != null
    ? `${latest.chop_proxy_ft} ft chop proxy`
    : "Rating pending";
  const fill = document.getElementById("scoreFill");
  if (fill && latest.score != null) fill.style.width = `${Math.max(6, Math.min(100, latest.score))}%`;
  renderForecastStrip(bundle.ten_day || []);
  renderWindChart(bundle.hourly || {});
}

async function loadLiveSpotData(spot) {
  try {
    const bundle = await fetchJson(`data/live/spots/${spot.slug}.json`);
    renderLiveSpotData(bundle);
  } catch (error) {
    console.warn("[LakePro] Live spot data unavailable", error);
    const grade = document.getElementById("conditionGrade");
    grade.textContent = "--";
    grade.dataset.grade = "";
    document.getElementById("conditionSummary").textContent = "Rating pending";
    renderForecastStrip();
    renderWindChart();
  }
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
  if (spot?.slug !== "payette-lake") return [];
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
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
  const bearing = flowBearing(frame);
  const radians = bearing * Math.PI / 180;
  const fetchOffset = Math.min(0.18, speed * 0.012);
  const centers = lakeGradientCenters(bounds, spot);
  const protectedCenters = lakeProtectionCenters(bounds, spot);

  context.save();
  tracePolygonPath(context, polygons);
  context.clip("evenodd");

  const base = context.createLinearGradient(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
  base.addColorStop(0, "rgba(24, 157, 232, 0.96)");
  base.addColorStop(0.52, "rgba(28, 116, 235, 0.94)");
  base.addColorStop(1, "rgba(25, 90, 220, 0.9)");
  context.fillStyle = base;
  context.fillRect(bounds.minX, bounds.minY, width, height);

  if (exposure > 0.03) {
    const windWash = context.createLinearGradient(
      bounds.minX - Math.sin(radians) * width * 0.2,
      bounds.minY + Math.cos(radians) * height * 0.2,
      bounds.maxX + Math.sin(radians) * width * 0.2,
      bounds.maxY - Math.cos(radians) * height * 0.2
    );
    windWash.addColorStop(0, `rgba(67, 87, 225, ${0.12 * exposure})`);
    windWash.addColorStop(0.46, `rgba(116, 74, 225, ${0.28 * exposure})`);
    windWash.addColorStop(1, `rgba(202, 42, 214, ${0.3 * exposure})`);
    context.fillStyle = windWash;
    context.fillRect(bounds.minX, bounds.minY, width, height);

    for (const center of centers) {
      const exposedX = center.x + Math.sin(radians) * width * fetchOffset;
      const exposedY = center.y - Math.cos(radians) * height * fetchOffset;
      const rough = context.createRadialGradient(exposedX, exposedY, center.radius * 0.08, exposedX, exposedY, center.radius);
      rough.addColorStop(0, `rgba(242, 11, 198, ${0.62 * exposure})`);
      rough.addColorStop(0.34, `rgba(211, 45, 220, ${0.52 * exposure})`);
      rough.addColorStop(0.68, `rgba(88, 89, 231, ${0.32 * exposure})`);
      rough.addColorStop(0.92, `rgba(26, 127, 238, ${0.08 * exposure})`);
      rough.addColorStop(1, "rgba(18, 202, 234, 0)");
      context.fillStyle = rough;
      context.fillRect(bounds.minX, bounds.minY, width, height);
    }

    for (const center of protectedCenters) {
      const calm = context.createRadialGradient(center.x, center.y, center.radius * 0.08, center.x, center.y, center.radius);
      const calmStrength = center.strength * (1 - exposure * 0.55);
      calm.addColorStop(0, `rgba(31, 129, 232, ${calmStrength})`);
      calm.addColorStop(0.5, `rgba(39, 106, 224, ${calmStrength * 0.5})`);
      calm.addColorStop(0.84, `rgba(72, 93, 218, ${calmStrength * 0.18})`);
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
  shoreGlow.addColorStop(0.6, `rgba(31, 128, 232, ${payette ? 0.025 + exposure * 0.015 : 0.08 + exposure * 0.05})`);
  shoreGlow.addColorStop(0.84, `rgba(29, 145, 232, ${payette ? 0.07 + exposure * 0.025 : 0.22 + exposure * 0.08})`);
  shoreGlow.addColorStop(1, `rgba(31, 155, 232, ${payette ? 0.11 + exposure * 0.03 : 0.36 + exposure * 0.09})`);
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

  if (lakeMap) {
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

function updateMapForSpot(spot) {
  loadLakeShoreline(spot);
  setPayetteBoatingLayerVisibility(spot.slug === "payette-lake");

  if (!lakeMap) return;

  lakeMap.flyTo({
    center: [spot.longitude, spot.latitude],
    zoom: spot.slug === "lake-tahoe" ? 8.35 : 11.15,
    essential: true,
  });

  renderWindFrame(windFrameIndex);
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
  updateMapForSpot(currentSpot);
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
    attributionControl: true,
  });

  lakeMap.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), "top-right");
  ensureLakeSurfaceCanvas();
  requestAnimationFrame(resizeMapToPanel);
  window.setTimeout(resizeMapToPanel, 250);
  window.setTimeout(resizeMapToPanel, 1000);
  window.addEventListener("resize", resizeMapToPanel);
  lakeMap.once("load", () => {
    addPayetteBoatingLayers().finally(() => {
      resizeMapToPanel();
      setPayetteBoatingLayerVisibility(currentSpot?.slug === "payette-lake");
      renderWindFrame(windFrameIndex);
    });
  });
}

const activeSpot = selectedSpot();
renderSpotSwitcher(activeSpot);
renderSpot(activeSpot);
initMap(activeSpot);
