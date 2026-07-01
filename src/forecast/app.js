import { lakeSpots } from "../spots/index.js";
import { windFrameForSpot } from "../map/windFrameSource.js";

let lakeMap = null;
let homeMap = null;
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
const lakeShorelineBounds = new Map();
const lakeNarrowProtectionCache = new Map();
let currentLiveLatest = null;
let selectedForecastIndex = 0;
let homeCameraIndex = 0;

function cartoRasterStyle() {
  return {
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
  };
}

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

const approvedCameraOverrides = {
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

function cameraAssetUrl(spot) {
  if (!spot?.slug) return "assets/hero-image.jpg";
  return `assets/cameras/${spot.slug}.png`;
}

function cameraForSpot(spot) {
  if (!spot) return null;
  const override = approvedCameraOverrides[spot.slug];
  if (override) return override;
  if (!spot.webcam?.url) return null;
  return {
    title: "Live Lake View",
    description: spot.webcam.label || `Current ${spot.name} lake view`,
    sourceUrl: spot.webcam.url,
    imageUrl: cameraAssetUrl(spot),
    alt: `${spot.name} webcam screenshot`,
  };
}

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

function gradeRank(grade) {
  return { A: 5, B: 4, C: 3, D: 2, F: 1 }[grade] || 0;
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundedMph(value) {
  const number = numberValue(value);
  return number == null ? null : `${Math.round(number)} mph`;
}

function readableWindow(day = {}) {
  if (day.best_window && day.best_window !== "Pending") return day.best_window.toLowerCase();
  return "";
}

function bGradeChance(day = {}) {
  const score = numberValue(day.score);
  if (score != null) {
    const wind = numberValue(day.wind_speed_max_mph) || 0;
    const precip = numberValue(day.precipitation_probability_max) || 0;
    const adjusted = score - Math.max(0, wind - 8) * 1.4 - Math.max(0, precip - 45) * 0.35;
    return Math.max(3, Math.min(92, Math.round(adjusted / 5) * 5));
  }
  const grade = gradeValue(day.grade);
  if (grade === "A") return 80;
  if (grade === "B") return 60;
  if (grade === "C") return 30;
  if (grade === "D") return 12;
  if (grade === "F") return 5;
  return null;
}

function reportHook(day = {}, index = 0) {
  const grade = gradeValue(day.grade);
  const wind = numberValue(day.wind_speed_max_mph);
  const precip = numberValue(day.precipitation_probability_max) || 0;
  const window = readableWindow(day);

  if (grade === "F" || wind >= 24) return index === 0 ? "Skip the open water." : "This one looks rough.";
  if (wind >= 16 || grade === "D") return "Wind may make this one tricky.";
  if (precip >= 55 && gradeRank(grade) <= gradeRank("C")) return "Worth watching, but not a lock.";
  if (window.includes("early") || window.includes("morning")) return "Catch the lake early.";
  if (window.includes("evening") || window.includes("afternoon")) return "The cleaner window may come later.";
  if (grade === "A") return "This is one of the better windows of the week.";
  if (grade === "B") return "Worth planning around.";
  return "Best window looks short.";
}

function timingLine(day = {}, index = 0) {
  const grade = gradeValue(day.grade);
  const window = readableWindow(day);
  const gradeText = grade ? `${grade}-grade` : "rated";
  if (index === 0) {
    if (window) return `Conditions look ${gradeText} during the ${window} window.`;
    return `The model has today at ${gradeText}, but the cleanest window is still forming.`;
  }
  const label = day.label || dayLabel(day.date, index);
  if (window) return `${label} is tracking ${gradeText}, with the best setup most likely ${window}.`;
  return `${label} is tracking ${gradeText}, but the timing window is still uncertain.`;
}

function changeLine(day = {}, index = 0, today = {}) {
  const grade = gradeValue(day.grade);
  const wind = numberValue(day.wind_speed_max_mph);
  const todayRank = gradeRank(today.grade);
  const dayRank = gradeRank(grade);
  const comparison = index === 0 || !todayRank || !dayRank
    ? ""
    : dayRank > todayRank
      ? "better than today"
      : dayRank < todayRank
        ? "worse than today"
        : "similar to today";

  if (wind >= 16) return `Open water may get messy, while protected coves should hold the best relative water.`;
  if (wind >= 8) return `Expect conditions to shift as wind builds, with open and exposed zones getting choppier first.`;
  if (comparison) return `The setup looks ${comparison}, with calmer water most likely before traffic and afternoon texture build.`;
  return "Morning should be the safer bet before traffic and texture have time to build.";
}

function driverLine(day = {}) {
  const parts = [];
  const wind = roundedMph(day.wind_speed_max_mph);
  const gust = roundedMph(day.wind_gust_max_mph);
  const chop = day.chop_proxy_ft == null ? "" : `${day.chop_proxy_ft} ft chop proxy`;
  const precip = numberValue(day.precipitation_probability_max);
  const trafficPenalty = numberValue(day.crowding_penalty);

  if (wind) parts.push(gust && gust !== wind ? `wind near ${wind}, gusting around ${gust}` : `wind near ${wind}`);
  if (chop) parts.push(chop);
  if (precip != null && precip >= 35) parts.push(`${Math.round(precip)}% precip risk`);
  if (trafficPenalty != null && trafficPenalty > 0) parts.push("boat traffic penalty is in the model");

  if (!parts.length) return "The main drivers are still pending in the live feed.";
  return `Main drivers: ${parts.join(", ")}.`;
}

function confidenceLine(day = {}) {
  const chance = bGradeChance(day);
  const missingWindow = !day.best_window || day.best_window === "Pending";
  const summary = String(day.summary || "");
  const confidence = missingWindow || summary.includes("fill") ? "medium" : "solid";
  if (chance == null) return `Confidence is ${confidence}; the B-grade-or-better estimate is pending.`;
  return `Model estimate: about a ${chance}% shot at holding B-grade or better. Confidence is ${confidence}.`;
}

function generateLakeForecastReport(day = {}, index = 0, days = []) {
  const title = index === 0 ? "Daily Lake Forecast" : `${day.label || dayLabel(day.date, index)} Lake Forecast`;
  return {
    title,
    grade: gradeValue(day.grade),
    hook: reportHook(day, index),
    lines: [
      timingLine(day, index),
      changeLine(day, index, days[0] || {}),
      driverLine(day),
      confidenceLine(day),
    ].filter(Boolean),
  };
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
    const card = document.createElement("button");
    card.className = "forecast-day";
    card.type = "button";
    card.dataset.active = index === selectedForecastIndex ? "true" : "false";
    card.setAttribute("aria-pressed", index === selectedForecastIndex ? "true" : "false");
    card.setAttribute("aria-expanded", index === selectedForecastIndex ? "true" : "false");
    card.setAttribute("aria-controls", "forecastReportDropdown");
    const grade = gradeValue(day.grade);
    card.innerHTML = `
      <span>${day.label || dayLabel(day.date, index)}</span>
      <i class="weather-icon ${weatherIconClass(day)}" aria-hidden="true"></i>
      ${temperatureRange(day)}
      <strong class="grade-letter" data-grade="${grade}">${day.grade || "--"}</strong>
      <em>${forecastDetail(day)}</em>
    `;
    card.addEventListener("click", () => {
      selectedForecastIndex = index;
      renderForecastStrip(days);
      renderForecastReports(days);
    });
    return card;
  }));
}

function createForecastReportArticle(report, className = "forecast-report") {
  const article = document.createElement("article");
  article.className = className;
  article.innerHTML = `
    <div class="forecast-report-summary">
      <span>
        <b>${report.title}</b>
        <small>${report.hook}</small>
      </span>
      <strong class="grade-letter" data-grade="${report.grade}">${report.grade || "--"}</strong>
    </div>
    <div class="forecast-report-body">
      ${report.lines.map((line) => `<p>${line}</p>`).join("")}
    </div>
  `;
  return article;
}

function renderForecastReports(days = placeholderForecast) {
  const index = Math.max(0, Math.min(selectedForecastIndex, days.length - 1));
  selectedForecastIndex = index;
  const day = days[index] || {};
  const dayReport = generateLakeForecastReport(day, index, days);
  const dropdown = document.getElementById("forecastReportDropdown");
  const heroReport = document.getElementById("heroDailyReport");
  const mobileReport = document.getElementById("mobileDailyReport");
  if (dropdown) {
    dropdown.replaceChildren(createForecastReportArticle(dayReport, "forecast-report forecast-dropdown-report"));
  }
  if (heroReport) heroReport.replaceChildren(createForecastReportArticle(dayReport, "forecast-report hero-forecast-report"));
  if (mobileReport) mobileReport.replaceChildren(createForecastReportArticle(dayReport, "forecast-report mobile-forecast-report"));
}

async function fetchGeoJson(url) {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`${url} unavailable`);
  return response.json();
}

async function fetchOptionalGeoJson(url) {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) return null;
  return response.json();
}

function selectedSpot() {
  const params = new URLSearchParams(window.location.search);
  return lakeSpots.find((spot) => spot.slug === params.get("spot"))
    || lakeSpots.find((spot) => spot.slug === defaultSpotSlug)
    || lakeSpots[0];
}

function isHomePage() {
  return !new URLSearchParams(window.location.search).has("spot");
}

function setPageMode(mode) {
  document.body.classList.toggle("home-mode", mode === "home");
  document.body.classList.toggle("spot-mode", mode === "spot");
}

function spotReportUrl(spot) {
  return `?spot=${spot.slug}`;
}

function renderHomeLakeLinks() {
  const container = document.getElementById("homeLakeLinks");
  if (!container) return;
  const prioritySpots = lakeSpots.filter((spot) => spot.featured || spot.liveReady);
  const catalogSpots = lakeSpots.filter((spot) => spot.homeMap !== false && !prioritySpots.includes(spot));
  const visibleSpots = [...prioritySpots, ...catalogSpots].slice(0, 28);
  container.replaceChildren(...visibleSpots.map((spot) => {
    const link = document.createElement("a");
    link.className = "home-lake-link";
    link.href = spotReportUrl(spot);
    const camera = cameraForSpot(spot);
    link.dataset.name = `${spot.name} ${spot.location}`.toLowerCase();
    link.innerHTML = `
      <span class="home-lake-copy">
        <b>${spot.name}</b>
        <small>${spot.location}</small>
        <em><strong class="grade-letter">--</strong> Loading</em>
      </span>
      <img src="${camera?.imageUrl || "assets/hero-image.jpg"}" alt="${spot.name} preview">
    `;
    const image = link.querySelector("img");
    if (image) image.onerror = () => { image.src = "assets/hero-image.jpg"; };
    return link;
  }));
  hydrateHomeLakeCards();
  wireHomeSearch();
  wireSpotSearch();
  renderHomeCameraSlider();
  wireHomeCameraSlider();
}

function createHomeMapMarker(spot) {
  const marker = document.createElement("button");
  marker.className = "home-map-marker";
  marker.type = "button";
  marker.setAttribute("aria-label", `Show ${spot.name} map popup`);
  marker.innerHTML = `<span aria-hidden="true"></span>`;
  return marker;
}

function createHomeMapPopup(spot) {
  const container = document.createElement("div");
  container.className = "home-map-popup";
  container.innerHTML = `
    <a href="${spotReportUrl(spot)}">${spot.name}</a>
    <span>${spot.location}</span>
  `;
  container.querySelector("a")?.addEventListener("click", (event) => {
    event.preventDefault();
    selectSpotBySlug(spot.slug);
  });
  return container;
}

function fitHomeMap(duration = 0) {
  if (!homeMap) return;
  const narrow = window.matchMedia("(max-width: 820px)").matches;
  homeMap.fitBounds([[-125.2, 24.2], [-66.7, 49.5]], {
    padding: narrow
      ? { top: 34, right: 22, bottom: 34, left: 22 }
      : { top: 42, right: 54, bottom: 42, left: 54 },
    duration,
    essential: true,
  });
}

function initHomeMap() {
  const container = document.getElementById("homeUsMap");
  if (!container || !window.maplibregl) return;
  if (homeMap) {
    homeMap.resize();
    fitHomeMap(0);
    return;
  }

  homeMap = new window.maplibregl.Map({
    container,
    style: cartoRasterStyle(),
    center: [-97.2, 38.6],
    zoom: window.matchMedia("(max-width: 820px)").matches ? 2.25 : 3.25,
    minZoom: 2,
    attributionControl: false,
  });

  homeMap.addControl(new window.maplibregl.AttributionControl({ compact: true }), "top-left");
  homeMap.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), "top-right");
  lakeSpots.filter((spot) => spot.homeMap !== false).forEach((spot) => {
    if (!Number.isFinite(spot.latitude) || !Number.isFinite(spot.longitude)) return;
    const popup = new window.maplibregl.Popup({
      closeButton: false,
      closeOnClick: true,
      offset: 18,
      maxWidth: "220px",
    }).setDOMContent(createHomeMapPopup(spot));

    new window.maplibregl.Marker({
      element: createHomeMapMarker(spot),
      anchor: "bottom",
    })
      .setLngLat([spot.longitude, spot.latitude])
      .setPopup(popup)
      .addTo(homeMap);
  });
  homeMap.once("load", () => fitHomeMap(0));
  window.addEventListener("resize", () => {
    if (!document.body.classList.contains("home-mode")) return;
    homeMap.resize();
    fitHomeMap(0);
  });
}

async function hydrateHomeLakeCards() {
  const cards = [...document.querySelectorAll(".home-lake-link")];
  await Promise.all(cards.map(async (card) => {
    const slug = new URL(card.href).searchParams.get("spot");
    try {
      const bundle = await fetchJson(`data/live/spots/${slug}.json`);
      const latest = bundle.latest || {};
      const grade = gradeValue(latest.grade) || "--";
      const detail = latest.chop_proxy_ft != null ? `${latest.chop_proxy_ft} ft chop` : `${Math.round(latest.wind_speed_max_mph || 0)} mph`;
      const gradeNode = card.querySelector(".grade-letter");
      if (gradeNode) {
        gradeNode.textContent = grade;
        gradeNode.dataset.grade = gradeValue(grade);
      }
      const em = card.querySelector("em");
      if (em) em.lastChild.textContent = ` ${detail}`;
    } catch (error) {
      console.warn("[LakePro] Home lake card data unavailable", error);
    }
  }));

  renderHomeCameraSlide(homeCameraIndex);
}

function homeCameraSpots() {
  return lakeSpots.filter((spot) => cameraForSpot(spot));
}

function renderHomeCameraSlide(index = homeCameraIndex) {
  const slides = homeCameraSpots();
  if (!slides.length) return;
  homeCameraIndex = ((index % slides.length) + slides.length) % slides.length;
  const featureSpot = slides[homeCameraIndex];
  const camera = cameraForSpot(featureSpot);
  const featureLink = document.getElementById("homeFeatureLink");
  const featureImage = document.getElementById("homeFeatureImage");
  const featureName = document.getElementById("homeFeatureName");
  const featureLocation = document.getElementById("homeFeatureLocation");
  const featureShortLocation = document.getElementById("homeFeatureShortLocation");
  if (featureLink) featureLink.href = `?spot=${featureSpot.slug}`;
  if (featureImage && camera) {
    featureImage.onerror = () => { featureImage.src = "assets/hero-image.jpg"; };
    featureImage.src = camera.imageUrl;
    featureImage.alt = camera.alt;
  }
  if (featureName) featureName.textContent = featureSpot.name;
  if (featureLocation) featureLocation.textContent = featureSpot.location;
  if (featureShortLocation) {
    const state = featureSpot.location.split(",").pop()?.trim() || "";
    featureShortLocation.textContent = `${featureSpot.name}${state ? `, ${state}` : ""}`;
  }
  document.querySelectorAll(".home-camera-dot").forEach((dot, dotIndex) => {
    dot.dataset.active = dotIndex === homeCameraIndex ? "true" : "false";
    dot.setAttribute("aria-current", dotIndex === homeCameraIndex ? "true" : "false");
  });
}

function renderHomeCameraSlider() {
  const dots = document.getElementById("homeCameraDots");
  if (!dots) return;
  const slides = homeCameraSpots();
  dots.replaceChildren(...slides.map((spot, index) => {
    const button = document.createElement("button");
    button.className = "home-camera-dot";
    button.type = "button";
    button.dataset.active = index === homeCameraIndex ? "true" : "false";
    button.setAttribute("aria-label", `Show ${spot.name} camera`);
    button.addEventListener("click", () => renderHomeCameraSlide(index));
    return button;
  }));
  const hasMultipleSlides = slides.length > 1;
  document.querySelectorAll(".home-camera-control, .home-camera-dots").forEach((element) => {
    element.hidden = !hasMultipleSlides;
  });
  renderHomeCameraSlide(homeCameraIndex);
}

function wireHomeCameraSlider() {
  const prev = document.getElementById("homeCameraPrev");
  const next = document.getElementById("homeCameraNext");
  if (prev && prev.dataset.bound !== "true") {
    prev.dataset.bound = "true";
    prev.addEventListener("click", () => renderHomeCameraSlide(homeCameraIndex - 1));
  }
  if (next && next.dataset.bound !== "true") {
    next.dataset.bound = "true";
    next.addEventListener("click", () => renderHomeCameraSlide(homeCameraIndex + 1));
  }
}

function wireHomeSearch() {
  const input = document.getElementById("homeLakeSearch");
  if (!input || input.dataset.bound === "true") return;
  const results = document.getElementById("homeSearchResults");
  let activeIndex = 0;

  const openResults = () => {
    if (!results) return;
    renderHomeSearchResults(input.value, activeIndex);
    results.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };

  const closeResults = () => {
    if (!results) return;
    results.hidden = true;
    input.setAttribute("aria-expanded", "false");
  };

  const chooseActiveResult = () => {
    const matches = homeSearchMatches(input.value);
    const spot = matches[activeIndex] || matchingSpot(input.value);
    if (!spot) return false;
    input.blur();
    closeResults();
    selectSpotBySlug(spot.slug);
    return true;
  };

  input.dataset.bound = "true";
  if (results) results.hidden = true;
  input.addEventListener("input", () => {
    const query = input.value.trim().toLowerCase();
    document.querySelectorAll(".home-lake-link").forEach((card) => {
      card.hidden = Boolean(query) && !card.dataset.name.includes(query);
    });
    activeIndex = 0;
    openResults();
  });
  input.addEventListener("focus", openResults);
  input.addEventListener("blur", () => {
    window.setTimeout(closeResults, 140);
  });
  input.addEventListener("keydown", (event) => {
    const matches = homeSearchMatches(input.value);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      activeIndex = matches.length ? (activeIndex + 1) % matches.length : 0;
      openResults();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      activeIndex = matches.length ? (activeIndex - 1 + matches.length) % matches.length : 0;
      openResults();
      return;
    }
    if (event.key === "Escape") {
      closeResults();
      return;
    }
    if (event.key !== "Enter") return;
    if (!chooseActiveResult()) return;
    event.preventDefault();
  });
}

function homeSearchMatches(query) {
  const normalized = query.trim().toLowerCase();
  const source = normalized
    ? lakeSpots.filter((spot) => `${spot.name} ${spot.location}`.toLowerCase().includes(normalized))
    : lakeSpots;
  return source.slice(0, 8);
}

function renderHomeSearchResults(query, activeIndex = 0) {
  const results = document.getElementById("homeSearchResults");
  if (!results) return;
  const matches = homeSearchMatches(query);
  if (!matches.length) {
    const empty = document.createElement("div");
    empty.className = "home-search-empty";
    empty.textContent = "No matching lakes yet";
    results.replaceChildren(empty);
    return;
  }
  results.replaceChildren(...matches.map((spot, index) => {
    const option = document.createElement("button");
    option.className = "home-search-option";
    option.type = "button";
    option.setAttribute("role", "option");
    option.dataset.active = String(index === activeIndex);
    option.setAttribute("aria-selected", String(index === activeIndex));

    const name = document.createElement("strong");
    name.textContent = spot.name;
    const location = document.createElement("small");
    location.textContent = spot.location;
    option.append(name, location);
    option.addEventListener("mousedown", (event) => event.preventDefault());
    option.addEventListener("click", () => selectSpotBySlug(spot.slug));
    return option;
  }));
}

function matchingSpot(query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return null;
  return lakeSpots.find((spot) => spot.name.toLowerCase() === normalized)
    || lakeSpots.find((spot) => `${spot.name} ${spot.location}`.toLowerCase().includes(normalized));
}

function wireSpotSearch() {
  const input = document.getElementById("spotLakeSearch");
  if (!input || input.dataset.bound === "true") return;
  input.dataset.bound = "true";
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const spot = matchingSpot(input.value);
    if (!spot) return;
    event.preventDefault();
    input.blur();
    selectSpotBySlug(spot.slug);
  });
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
  setPageMode("spot");
  const select = document.getElementById("spotSelect");
  if (select) select.value = nextSpot.slug;
  renderSpot(nextSpot);
  if (!lakeMap) initMap(nextSpot);
  else updateMapForSpot(nextSpot);
}

function renderSpot(spot) {
  currentSpot = spot;
  currentLiveLatest = null;
  selectedForecastIndex = 0;
  document.getElementById("spotName").textContent = spot.name;
  document.getElementById("spotLocation").textContent = spot.location;
  const pageSpotName = document.getElementById("pageSpotName");
  const pageSpotLocation = document.getElementById("pageSpotLocation");
  if (pageSpotName) pageSpotName.textContent = spot.name;
  if (pageSpotLocation) pageSpotLocation.textContent = spot.location;
  renderCameraCard(spot);
  loadLiveSpotData(spot);
  loadWindTimelapse(spot);
  loadLakeShoreline(spot);
}

function renderCameraCard(spot) {
  const camera = cameraForSpot(spot);
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
  image.onerror = () => { image.src = "assets/hero-image.jpg"; };
  image.src = camera.imageUrl;
  image.alt = camera.alt;
}

function renderLiveSpotData(bundle) {
  const latest = bundle.latest || {};
  currentLiveLatest = latest;
  renderCondition(latest);
  renderForecastStrip(bundle.ten_day || []);
  renderForecastReports(bundle.ten_day || []);
}

async function loadLiveSpotData(spot) {
  try {
    const bundle = await fetchJson(`data/live/spots/${spot.slug}.json`);
    if (currentSpot?.slug !== spot.slug) return;
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
    renderForecastReports();
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

function liveDateKey(spot = currentSpot) {
  return localHourKey(new Date(), spot?.timeZone).slice(0, 10);
}

function localHourKey(date = new Date(), timeZone) {
  if (!timeZone || Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce((memo, part) => {
    if (part.type !== "literal") memo[part.type] = part.value;
    return memo;
  }, {});
  if (!parts.year || !parts.month || !parts.day || !parts.hour) return "";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}`;
}

function frameLocalHourKey(time) {
  const match = String(time || "").match(/^(\d{4}-\d{2}-\d{2})T(\d{2})/);
  return match ? `${match[1]}T${match[2]}` : "";
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
      rings.push(geometry.coordinates);
    }
    if (geometry.type === "MultiPolygon") {
      rings.push(...geometry.coordinates);
    }
  }
  return rings;
}

async function loadLakeShoreline(spot) {
  if (loadedShorelineSlug === spot.slug) {
    drawLakeSurfaceOverlay(performance.now());
    return;
  }
  try {
    const shoreline = await loadShorelineGeoJson(spot);
    if (currentSpot?.slug !== spot.slug) return;
    lakeSurfaceRings = shoreline ? extractLakeRings(shoreline) : [];
    const bounds = shoreline ? geoJsonLngLatBounds(shoreline) : null;
    if (bounds) lakeShorelineBounds.set(spot.slug, bounds);
    lakeSurfaceParticles = [];
    loadedShorelineSlug = spot.slug;
    if (lakeMap) fitMapToSpot(spot, 0);
    drawLakeSurfaceOverlay(performance.now());
  } catch (error) {
    console.warn("[LakePro] Shoreline mask unavailable", error);
    lakeSurfaceRings = [];
    lakeSurfaceParticles = [];
    loadedShorelineSlug = spot.slug;
    drawLakeSurfaceOverlay(performance.now());
  }
}

async function loadShorelineGeoJson(spot) {
  const staticUrls = [
    mapLayerUrls.shorelines[spot.slug],
    `data/live/map_layers/${spot.slug}_shoreline.geojson`,
  ].filter(Boolean);

  for (const url of staticUrls) {
    const shoreline = await fetchOptionalGeoJson(url);
    if (shoreline?.features?.length) return shoreline;
  }

  return fetchOsmShorelineGeoJson(spot);
}

async function fetchOsmShorelineGeoJson(spot) {
  if (!spot?.latitude || !spot?.longitude) return null;
  const cacheKey = `lakepro:shoreline:${spot.slug}:v1`;
  try {
    const cached = window.localStorage?.getItem(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {
    // Local storage is an optional speed-up only.
  }

  const radiusMeters = spot.slug.includes("powell") || spot.slug.includes("mead") || spot.slug.includes("amistad")
    ? 48000
    : 26000;

  const relationShoreline = await fetchOsmRelationShorelineGeoJson(spot, radiusMeters);
  if (relationShoreline?.features?.length) {
    try {
      window.localStorage?.setItem(cacheKey, JSON.stringify(relationShoreline));
    } catch {
      // Ignore storage quota/private-mode failures.
    }
    return relationShoreline;
  }

  const query = `
    [out:json][timeout:25];
    (
      way(around:${radiusMeters},${spot.latitude},${spot.longitude})["natural"="water"];
      way(around:${radiusMeters},${spot.latitude},${spot.longitude})["water"="reservoir"];
      way(around:${radiusMeters},${spot.latitude},${spot.longitude})["water"="lake"];
    );
    out tags geom;
  `;
  const response = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({ data: query }),
  });
  if (!response.ok) return null;
  const osm = await response.json();
  const shoreline = osmWaterWaysToGeoJson(osm, spot);
  if (!shoreline.features.length) return null;

  try {
    window.localStorage?.setItem(cacheKey, JSON.stringify(shoreline));
  } catch {
    // Ignore storage quota/private-mode failures.
  }
  return shoreline;
}

async function fetchOsmRelationShorelineGeoJson(spot, radiusMeters) {
  const relationQuery = `
    [out:json][timeout:25];
    (
      relation(around:${radiusMeters},${spot.latitude},${spot.longitude})["type"="multipolygon"]["natural"="water"];
      relation(around:${radiusMeters},${spot.latitude},${spot.longitude})["type"="multipolygon"]["water"~"^(lake|reservoir)$"];
    );
    out tags center;
  `;
  const relationResponse = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({ data: relationQuery }),
  });
  if (!relationResponse.ok) return null;
  const relationList = await relationResponse.json();
  const relation = chooseOsmWaterRelation(relationList, spot);
  if (!relation) return null;

  const geometryQuery = `
    [out:json][timeout:45];
    relation(${relation.id});
    out body;
    way(r);
    out geom;
  `;
  const geometryResponse = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({ data: geometryQuery }),
  });
  if (!geometryResponse.ok) return null;
  const osm = await geometryResponse.json();
  return osmWaterRelationToGeoJson(osm, spot, relation.id);
}

function chooseOsmWaterRelation(osm, spot) {
  const terms = spot.name.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2);
  return (osm?.elements || [])
    .filter((element) => element.type === "relation")
    .map((element) => {
      const name = String(element.tags?.name || "").toLowerCase();
      const nameScore = terms.filter((term) => name.includes(term)).length;
      const center = element.center || {};
      const centerDistance = Number.isFinite(center.lon) && Number.isFinite(center.lat)
        ? Math.hypot(center.lon - spot.longitude, center.lat - spot.latitude)
        : Infinity;
      return { element, nameScore, centerDistance };
    })
    .sort((a, b) => (b.nameScore - a.nameScore) || (a.centerDistance - b.centerDistance))[0]?.element || null;
}

function osmWaterRelationToGeoJson(osm, spot, relationId) {
  const relation = (osm?.elements || []).find((element) => element.type === "relation" && element.id === relationId);
  if (!relation) return emptyFeatureCollection();

  const ways = new Map((osm?.elements || [])
    .filter((element) => element.type === "way" && Array.isArray(element.geometry) && element.geometry.length > 1)
    .map((element) => [element.id, element.geometry.map((point) => [point.lon, point.lat])]));

  const rings = assembleOsmRings((relation.members || [])
    .filter((member) => member.type === "way" && member.role !== "inner")
    .map((member) => ways.get(member.ref))
    .filter(Boolean));

  const validRings = rings.filter((ring) => ring.length >= 4);
  if (!validRings.length) return emptyFeatureCollection();

  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {
        source: "OpenStreetMap",
        osm_type: "relation",
        osm_id: relationId,
        name: relation.tags?.name || spot.name,
      },
      geometry: {
        type: validRings.length === 1 ? "Polygon" : "MultiPolygon",
        coordinates: validRings.length === 1 ? [validRings[0]] : validRings.map((ring) => [ring]),
      },
    }],
  };
}

function assembleOsmRings(segments) {
  const remaining = segments
    .map((segment) => segment.filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat)))
    .filter((segment) => segment.length > 1);
  const rings = [];

  while (remaining.length) {
    let ring = remaining.shift();
    let changed = true;
    while (!isClosedRing(ring) && changed) {
      changed = false;
      const start = coordinateKey(ring[0]);
      const end = coordinateKey(ring.at(-1));
      const matchIndex = remaining.findIndex((segment) => {
        const segmentStart = coordinateKey(segment[0]);
        const segmentEnd = coordinateKey(segment.at(-1));
        return segmentStart === end || segmentEnd === end || segmentEnd === start || segmentStart === start;
      });
      if (matchIndex < 0) continue;
      const next = remaining.splice(matchIndex, 1)[0];
      const nextStart = coordinateKey(next[0]);
      const nextEnd = coordinateKey(next.at(-1));
      if (nextStart === end) ring = ring.concat(next.slice(1));
      else if (nextEnd === end) ring = ring.concat([...next].reverse().slice(1));
      else if (nextEnd === start) ring = next.concat(ring.slice(1));
      else if (nextStart === start) ring = [...next].reverse().concat(ring.slice(1));
      changed = true;
    }
    if (isClosedRing(ring)) rings.push(ring);
  }

  return rings.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
}

function emptyFeatureCollection() {
  return { type: "FeatureCollection", features: [] };
}

function coordinateKey(coordinate) {
  return `${coordinate[0].toFixed(6)},${coordinate[1].toFixed(6)}`;
}

function isClosedRing(ring) {
  return ring.length >= 4 && coordinateKey(ring[0]) === coordinateKey(ring.at(-1));
}

function ringArea(ring) {
  let area = 0;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    area += (ring[previous][0] * ring[index][1]) - (ring[index][0] * ring[previous][1]);
  }
  return area / 2;
}

function osmWaterWaysToGeoJson(osm, spot) {
  const spotTerms = new Set([
    ...spot.name.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2),
    "lake",
    "reservoir",
  ]);
  const candidates = [];

  for (const element of osm?.elements || []) {
    const geometry = element.geometry || [];
    if (element.type !== "way" || geometry.length < 4) continue;
    const tags = element.tags || {};
    if (!(tags.natural === "water" || tags.water === "reservoir" || tags.water === "lake")) continue;

    const coordinates = geometry.map((point) => [point.lon, point.lat]);
    if (!coordinates.length || coordinates[0][0] !== coordinates.at(-1)[0] || coordinates[0][1] !== coordinates.at(-1)[1]) continue;

    const name = String(tags.name || "").toLowerCase();
    const nameScore = name
      ? [...spotTerms].filter((term) => name.includes(term)).length
      : 0;
    const bounds = lngLatBounds(coordinates);
    const area = Math.abs((bounds.east - bounds.west) * (bounds.north - bounds.south));
    const centerDistance = Math.hypot(
      ((bounds.west + bounds.east) / 2) - spot.longitude,
      ((bounds.south + bounds.north) / 2) - spot.latitude
    );
    candidates.push({ coordinates, tags, area, nameScore, centerDistance, id: element.id });
  }

  const relevant = candidates
    .filter((candidate) => candidate.area > 0.000002)
    .sort((a, b) => (b.nameScore - a.nameScore) || (b.area - a.area) || (a.centerDistance - b.centerDistance))
    .slice(0, 24);

  return {
    type: "FeatureCollection",
    features: relevant.map((candidate) => ({
      type: "Feature",
      properties: {
        source: "OpenStreetMap",
        osm_type: "way",
        osm_id: candidate.id,
        name: candidate.tags.name || spot.name,
      },
      geometry: {
        type: "Polygon",
        coordinates: [candidate.coordinates],
      },
    })),
  };
}

function lngLatBounds(coordinates) {
  return coordinates.reduce((bounds, [lng, lat]) => ({
    west: Math.min(bounds.west, lng),
    south: Math.min(bounds.south, lat),
    east: Math.max(bounds.east, lng),
    north: Math.max(bounds.north, lat),
  }), { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity });
}

function geoJsonLngLatBounds(geojson) {
  const flatCoordinates = [];
  for (const feature of geojson?.features || []) {
    const geometry = feature.geometry || {};
    if (geometry.type === "Polygon") {
      flatCoordinates.push(...geometry.coordinates.flat());
    } else if (geometry.type === "MultiPolygon") {
      flatCoordinates.push(...geometry.coordinates.flat(2));
    }
  }
  if (!flatCoordinates.length) return null;
  const bounds = lngLatBounds(flatCoordinates);
  if (!Number.isFinite(bounds.west) || bounds.east <= bounds.west || bounds.north <= bounds.south) return null;
  return [bounds.west, bounds.south, bounds.east, bounds.north];
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
  if (!lakeSurfaceRings.length) return [];
  return lakeSurfaceRings.map((polygon) => polygon.map((ring) => ring.map(([lng, lat]) => {
    const point = lakeMap.project([lng, lat]);
    return [point.x * dpr, point.y * dpr];
  })));
}

function fallbackLakePolygons(dpr, spot) {
  if (!lakeMap || !spot) return [];
  const mapCanvas = lakeMap.getCanvas();
  const center = lakeMap.project([spot.longitude, spot.latitude]);
  const width = mapCanvas.clientWidth * dpr;
  const height = mapCanvas.clientHeight * dpr;
  const radiusX = Math.max(110 * dpr, Math.min(width * 0.24, 290 * dpr));
  const radiusY = Math.max(150 * dpr, Math.min(height * 0.34, 390 * dpr));
  const rotation = fallbackLakeRotation(spot);
  const radians = rotation * Math.PI / 180;
  const ring = [];

  for (let index = 0; index < 72; index += 1) {
    const angle = (index / 72) * Math.PI * 2;
    const branchBias = Math.abs(Math.sin(angle)) ** 1.8;
    const wobble = 1 + Math.sin(angle * 3) * 0.07 + Math.cos(angle * 5) * 0.04;
    const x = Math.cos(angle) * radiusX * (0.78 + branchBias * 0.28) * wobble;
    const y = Math.sin(angle) * radiusY * (0.92 + Math.abs(Math.cos(angle)) * 0.14) * wobble;
    ring.push([
      (center.x * dpr) + x * Math.cos(radians) - y * Math.sin(radians),
      (center.y * dpr) + x * Math.sin(radians) + y * Math.cos(radians),
    ]);
  }

  return [[ring]];
}

function fallbackLakeRotation(spot) {
  const slug = spot?.slug || "";
  if (slug.includes("travis") || slug.includes("austin")) return -34;
  if (slug.includes("amistad") || slug.includes("texoma") || slug.includes("powell")) return 74;
  if (slug.includes("havasu") || slug.includes("mead") || slug.includes("mohave")) return 14;
  return 18;
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

function distanceToSegmentSquared(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (dx === 0 && dy === 0) {
    const sx = point.x - start[0];
    const sy = point.y - start[1];
    return sx * sx + sy * sy;
  }
  const t = Math.max(0, Math.min(1, ((point.x - start[0]) * dx + (point.y - start[1]) * dy) / (dx * dx + dy * dy)));
  const x = start[0] + t * dx;
  const y = start[1] + t * dy;
  const px = point.x - x;
  const py = point.y - y;
  return px * px + py * py;
}

function distanceToLakeEdge(point, polygons) {
  let best = Infinity;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let index = 0; index < ring.length; index += 1) {
        const start = ring[index];
        const end = ring[(index + 1) % ring.length];
        best = Math.min(best, distanceToSegmentSquared(point, start, end));
      }
    }
  }
  return Math.sqrt(best);
}

function narrowProtectionCacheKey(bounds, spot) {
  return [
    spot?.slug || "lake",
    Math.round(bounds.minX),
    Math.round(bounds.minY),
    Math.round(bounds.maxX),
    Math.round(bounds.maxY),
  ].join(":");
}

function narrowWaterProtectionPoints(polygons, bounds, spot) {
  const key = narrowProtectionCacheKey(bounds, spot);
  if (lakeNarrowProtectionCache.has(key)) return lakeNarrowProtectionCache.get(key);

  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const maxDim = Math.max(width, height);
  const step = Math.max(26, Math.min(58, maxDim / 18));
  const protectedEdgeDistance = maxDim * 0.082;
  const fadeDistance = maxDim * 0.062;
  const points = [];

  for (let y = bounds.minY + step * 0.5; y <= bounds.maxY; y += step) {
    for (let x = bounds.minX + step * 0.5; x <= bounds.maxX; x += step) {
      const point = { x, y };
      if (!pointInLake(point, polygons)) continue;
      const edgeDistance = distanceToLakeEdge(point, polygons);
      const strength = Math.max(0, Math.min(1, (protectedEdgeDistance - edgeDistance) / fadeDistance));
      if (strength <= 0.06) continue;
      points.push({
        x,
        y,
        strength,
        radius: step * (1.45 + strength * 0.75),
      });
    }
  }

  if (lakeNarrowProtectionCache.size > 18) lakeNarrowProtectionCache.clear();
  lakeNarrowProtectionCache.set(key, points);
  return points;
}

function drawNarrowWaterProtection(context, polygons, bounds, frame, spot) {
  const speed = Number(frame?.wind_speed_mph || 0);
  const exposure = Math.max(0, Math.min(1, (speed - 5.5) / 6));
  if (exposure <= 0.04) return;

  const roughWind = Math.max(0, Math.min(1, (speed - 12) / 10));
  const dangerousWind = Math.max(0, Math.min(1, (speed - 24) / 8));
  const calmBase = (0.18 + exposure * 0.26 + roughWind * 0.14) * (1 - dangerousWind * 0.72);
  if (calmBase <= 0.02) return;

  const points = narrowWaterProtectionPoints(polygons, bounds, spot);
  for (const point of points) {
    const alpha = calmBase * point.strength;
    const calm = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, point.radius);
    calm.addColorStop(0, `rgba(24, 150, 232, ${alpha})`);
    calm.addColorStop(0.48, `rgba(43, 116, 229, ${alpha * 0.58})`);
    calm.addColorStop(0.82, `rgba(73, 96, 225, ${alpha * 0.2})`);
    calm.addColorStop(1, "rgba(24, 150, 232, 0)");
    context.fillStyle = calm;
    context.fillRect(bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  }
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

    drawNarrowWaterProtection(context, polygons, bounds, frame, spot);
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

  const polygons = projectedLakePolygons(dpr);
  if (!polygons.length) {
    lakeSurfaceCanvas.hidden = true;
    lastParticleFrame = timestamp;
    return;
  }
  lakeSurfaceCanvas.hidden = false;
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
    const currentDay = liveDateKey() || frameDateKey(windFrames[0]?.time);
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

function currentWindFrameIndex(now = new Date(), spot = currentSpot) {
  if (!windFrames.length) return 0;
  const targetHour = localHourKey(now, spot?.timeZone);
  if (targetHour) {
    const exactIndex = windFrames.findIndex((frame) => frameLocalHourKey(frame.time) === targetHour);
    if (exactIndex >= 0) return exactIndex;

    let previousIndex = -1;
    windFrames.forEach((frame, index) => {
      const frameHour = frameLocalHourKey(frame.time);
      if (frameHour && frameHour <= targetHour) previousIndex = index;
    });
    if (previousIndex >= 0) return previousIndex;
  }

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
  const bounds = mapViewBounds[spot.slug] || lakeShorelineBounds.get(spot.slug) || source?.bounds;
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
    style: cartoRasterStyle(),
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

function boot() {
  const activeSpot = selectedSpot();
  setPageMode(isHomePage() ? "home" : "spot");
  renderSpotSwitcher(activeSpot);
  renderHomeLakeLinks();
  if (isHomePage()) {
    initHomeMap();
  } else {
    renderSpot(activeSpot);
    initMap(activeSpot);
  }
}

window.addEventListener("popstate", () => {
  const activeSpot = selectedSpot();
  setPageMode(isHomePage() ? "home" : "spot");
  const select = document.getElementById("spotSelect");
  if (select) select.value = activeSpot.slug;
  if (isHomePage()) {
    initHomeMap();
  } else {
    renderSpot(activeSpot);
    if (!lakeMap) initMap(activeSpot);
    else updateMapForSpot(activeSpot);
  }
});

boot();
