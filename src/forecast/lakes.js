import { lakeSpots } from "../spots/index.js";

const list = document.getElementById("lakeDirectoryList");
const count = document.getElementById("lakeDirectoryCount");

function reportUrl(spot) {
  return `index.html?spot=${spot.slug}`;
}

function gradeValue(value) {
  const grade = String(value || "").trim().toUpperCase();
  return ["A", "B", "C", "D", "F"].includes(grade) ? grade : "";
}

function capGrade(grade, maxGrade) {
  const grades = ["A", "B", "C", "D", "F"];
  const gradeIndex = grades.indexOf(gradeValue(grade));
  const capIndex = grades.indexOf(gradeValue(maxGrade));
  if (gradeIndex < 0 || capIndex < 0) return gradeValue(grade);
  return gradeIndex < capIndex ? grades[capIndex] : grades[gradeIndex];
}

function heatAdjustedGrade(latest = {}) {
  const high = Number(latest.temperature_2m_max ?? latest.temperature_high_f ?? latest.temp_high_f);
  if (!Number.isFinite(high)) return gradeValue(latest.grade);
  if (high > 105) return capGrade(latest.grade, "C");
  if (high > 90) return capGrade(latest.grade, "B");
  return gradeValue(latest.grade);
}

function firstLetter(name = "") {
  const letter = name.trim().charAt(0).toUpperCase();
  return /^[A-Z]$/.test(letter) ? letter : "#";
}

function mapPreviewPlaceholderDataUri(spot) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 132 88" role="img" aria-label="${spot?.name || "Lake"} map preview">
      <rect width="132" height="88" rx="10" fill="#f8fbff"/>
      <path d="M-12 69 C18 56 28 70 58 58 S101 54 145 39" fill="none" stroke="#dfe8f3" stroke-width="3"/>
      <path d="M-8 28 C20 16 39 22 63 18 S104 12 142 18" fill="none" stroke="#edf3f8" stroke-width="10"/>
      <rect x="28" y="29" width="76" height="30" rx="15" fill="#e9f4fb"/>
      <text x="66" y="47" text-anchor="middle" font-family="Arial, sans-serif" font-size="9" font-weight="800" fill="#61708f">Map preview</text>
    </svg>
  `.trim().replace(/\s+/g, " ");
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function shorelineRingsFromGeoJson(geojson) {
  const rings = [];
  for (const feature of geojson?.features || []) {
    const geometry = feature?.geometry;
    if (geometry?.type === "Polygon") {
      rings.push(...geometry.coordinates);
    }
    if (geometry?.type === "MultiPolygon") {
      geometry.coordinates.forEach((polygon) => rings.push(...polygon));
    }
  }
  return rings
    .filter((ring) => Array.isArray(ring) && ring.length > 2)
    .map((ring) => ring.filter((point) => Number.isFinite(point?.[0]) && Number.isFinite(point?.[1])))
    .filter((ring) => ring.length > 2);
}

function projectedPreviewRings(rings) {
  const points = rings.flat();
  if (!points.length) return [];
  const lngs = points.map((point) => point[0]);
  const lats = points.map((point) => point[1]);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const lngSpan = Math.max(maxLng - minLng, 0.00001);
  const latSpan = Math.max(maxLat - minLat, 0.00001);
  const targetWidth = 112;
  const targetHeight = 68;
  const scale = Math.min(targetWidth / lngSpan, targetHeight / latSpan);
  const centerLng = (minLng + maxLng) / 2;
  const centerLat = (minLat + maxLat) / 2;
  return rings.map((ring) => ring.map(([lng, lat]) => {
    const x = 66 + (lng - centerLng) * scale;
    const y = 44 - (lat - centerLat) * scale;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" "));
}

function shorelineMapPreviewDataUri(spot, geojson) {
  const rings = projectedPreviewRings(shorelineRingsFromGeoJson(geojson));
  if (!rings.length) return "";
  const idSuffix = (spot?.slug || "lake").replace(/[^a-z0-9-]/gi, "");
  const polygons = rings.map((points) => `<polygon points="${points}"/>`).join("");
  const strokedPolygons = rings.map((points) => `<polygon points="${points}" fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="1.25"/>`).join("");
  const linePaths = Array.from({ length: 9 }, (_, index) => {
    const y = 16 + index * 7;
    const x = 20 + (index % 3) * 12;
    return `<path d="M${x} ${y} l26 -10"/>`;
  }).join("");
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 132 88" role="img" aria-label="${spot?.name || "Lake"} map preview">
      <defs>
        <linearGradient id="water-${idSuffix}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#17c0e8"/>
          <stop offset="0.52" stop-color="#1167ff"/>
          <stop offset="1" stop-color="#f20bc6"/>
        </linearGradient>
        <clipPath id="lake-${idSuffix}">
          ${polygons}
        </clipPath>
      </defs>
      <rect width="132" height="88" rx="10" fill="#f8fbff"/>
      <path d="M-12 69 C18 56 28 70 58 58 S101 54 145 39" fill="none" stroke="#dfe8f3" stroke-width="3"/>
      <path d="M-8 28 C20 16 39 22 63 18 S104 12 142 18" fill="none" stroke="#edf3f8" stroke-width="10"/>
      <g fill="url(#water-${idSuffix})" opacity="0.94">${polygons}</g>
      <g clip-path="url(#lake-${idSuffix})" stroke="#fff" stroke-linecap="round" stroke-width="1.7" opacity="0.48">${linePaths}</g>
      ${strokedPolygons}
    </svg>
  `.trim().replace(/\s+/g, " ");
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function fallbackMapPreview(spot) {
  return `
    <span class="directory-map-preview" aria-hidden="true">
      <img src="${mapPreviewPlaceholderDataUri(spot)}" alt="">
    </span>
  `;
}

function cardMedia(spot) {
  return fallbackMapPreview(spot);
}

function createLakeCard(spot) {
  const card = document.createElement("a");
  card.className = "directory-lake-card";
  card.href = reportUrl(spot);
  card.dataset.slug = spot.slug;
  card.innerHTML = `
    ${cardMedia(spot)}
    <span class="directory-lake-copy">
      <b>${spot.name}</b>
      <small>${spot.location}</small>
      <em><strong class="grade-letter" aria-label="Grade pending"></strong></em>
    </span>
  `;
  return card;
}

function renderDirectory() {
  const spots = lakeSpots
    .filter((spot) => spot.homeMap !== false)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  const groups = new Map();
  spots.forEach((spot) => {
    const letter = firstLetter(spot.name);
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(spot);
  });

  const sections = [...groups.entries()].map(([letter, group]) => {
    const section = document.createElement("section");
    section.className = "lake-directory-group";
    section.setAttribute("aria-labelledby", `lakeGroup${letter}`);
    section.innerHTML = `<h3 id="lakeGroup${letter}">${letter}</h3>`;
    const grid = document.createElement("div");
    grid.className = "lake-directory-grid";
    grid.replaceChildren(...group.map(createLakeCard));
    section.append(grid);
    return section;
  });

  list.replaceChildren(...sections);
  if (count) count.textContent = `${spots.length} lake reports`;
  hydrateDirectoryMapPreviews(spots);
  hydrateDirectoryCards(spots);
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} unavailable`);
  return response.json();
}

async function hydrateDirectoryMapPreviews(spots) {
  await Promise.allSettled(spots.map(async (spot) => {
    const card = list.querySelector(`[data-slug="${spot.slug}"]`);
    const image = card?.querySelector(".directory-map-preview img");
    if (!image) return;
    const shoreline = await fetchJson(`data/live/map_layers/${spot.slug}_shoreline.geojson`);
    const preview = shorelineMapPreviewDataUri(spot, shoreline);
    if (preview) image.src = preview;
  }));
}

async function hydrateDirectoryCards(spots) {
  await Promise.allSettled(spots.map(async (spot) => {
    const card = list.querySelector(`[data-slug="${spot.slug}"]`);
    if (!card) return;
    try {
      const bundle = await fetchJson(`data/live/spots/${spot.slug}.json`);
      const latest = bundle.latest || {};
      const grade = heatAdjustedGrade(latest);
      const gradeEl = card.querySelector(".grade-letter");
      if (gradeEl) {
        gradeEl.textContent = grade;
        gradeEl.dataset.grade = grade;
        gradeEl.setAttribute("aria-label", `${grade} grade`);
      }
    } catch (error) {
      console.warn("[LakePro] Directory card unavailable", spot.slug, error);
    }
  }));
}

renderDirectory();
