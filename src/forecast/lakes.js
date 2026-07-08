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

function previewSvgDataUri(svg) {
  if (!svg) return "";
  if (svg.startsWith("data:image/svg+xml")) return svg;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

let directoryPreviewPayloadPromise;

async function loadDirectoryPreviewSvgs() {
  if (!directoryPreviewPayloadPromise) {
    directoryPreviewPayloadPromise = fetchJson("data/live/home-previews.json").catch((error) => {
      console.warn("[LakePro] Directory map previews unavailable", error);
      return {};
    });
  }
  return directoryPreviewPayloadPromise;
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
  hydrateDirectoryCards(spots);
  hydrateDirectoryMapPreviews();
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} unavailable`);
  return response.json();
}

async function hydrateDirectoryCards(spots) {
  let summaryBySlug = new Map();
  try {
    const payload = await fetchJson("data/live/home-summary.json");
    const rows = Array.isArray(payload) ? payload : payload?.spots || [];
    summaryBySlug = new Map(rows.map((entry) => [entry.slug, entry]));
  } catch (error) {
    console.warn("[LakePro] Directory summary unavailable", error);
  }

  spots.forEach((spot) => {
    const card = list.querySelector(`[data-slug="${spot.slug}"]`);
    if (!card) return;
    const latest = summaryBySlug.get(spot.slug);
    if (!latest) return;
    const grade = heatAdjustedGrade(latest);
    const gradeEl = card.querySelector(".grade-letter");
    if (gradeEl) {
      gradeEl.textContent = grade;
      gradeEl.dataset.grade = grade;
      gradeEl.setAttribute("aria-label", `${grade} grade`);
    }
  });
}

async function hydrateDirectoryMapPreviews() {
  const previews = await loadDirectoryPreviewSvgs();
  list.querySelectorAll(".directory-lake-card").forEach((card) => {
    const svg = previews?.[card.dataset.slug];
    const image = card.querySelector(".directory-map-preview img");
    if (!svg || !image) return;
    image.src = previewSvgDataUri(svg);
  });
}

renderDirectory();
