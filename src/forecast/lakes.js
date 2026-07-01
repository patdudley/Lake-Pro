import { lakeSpots } from "../spots/index.js";
import { cameraForSpot } from "./cameras.js";

const list = document.getElementById("lakeDirectoryList");
const count = document.getElementById("lakeDirectoryCount");

function reportUrl(spot) {
  return `index.html?spot=${spot.slug}`;
}

function gradeValue(value) {
  return String(value || "--").trim().toUpperCase();
}

function firstLetter(name = "") {
  const letter = name.trim().charAt(0).toUpperCase();
  return /^[A-Z]$/.test(letter) ? letter : "#";
}

function fallbackMapPreview(spot) {
  return `
    <span class="directory-map-preview" aria-hidden="true">
      <span class="directory-map-line one"></span>
      <span class="directory-map-line two"></span>
      <span class="directory-map-dot"></span>
      <span class="directory-map-name">${spot.name}</span>
    </span>
  `;
}

function cardMedia(spot) {
  const camera = cameraForSpot(spot);
  if (!camera) return fallbackMapPreview(spot);
  return `
    <span class="directory-card-media has-camera">
      <img src="${camera.imageUrl}" alt="${camera.alt}">
      <span><i aria-hidden="true"></i>Live cam</span>
    </span>
  `;
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
      <em><strong class="grade-letter">--</strong><span>Loading report</span></em>
    </span>
  `;
  const image = card.querySelector("img");
  if (image) image.onerror = () => {
    const media = card.querySelector(".directory-card-media");
    if (media) media.outerHTML = fallbackMapPreview(spot);
  };
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
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} unavailable`);
  return response.json();
}

async function hydrateDirectoryCards(spots) {
  await Promise.allSettled(spots.map(async (spot) => {
    const card = list.querySelector(`[data-slug="${spot.slug}"]`);
    if (!card) return;
    try {
      const bundle = await fetchJson(`data/live/spots/${spot.slug}.json`);
      const latest = bundle.latest || {};
      const grade = gradeValue(latest.grade);
      const detail = latest.chop_proxy_ft != null
        ? `${latest.chop_proxy_ft} ft chop`
        : latest.wind_speed_mph != null
          ? `${Math.round(latest.wind_speed_mph)} mph`
          : "Report pending";
      const gradeEl = card.querySelector(".grade-letter");
      if (gradeEl) {
        gradeEl.textContent = grade;
        gradeEl.dataset.grade = grade;
      }
      const detailEl = card.querySelector("em span");
      if (detailEl) detailEl.textContent = detail;
    } catch (error) {
      const detailEl = card.querySelector("em span");
      if (detailEl) detailEl.textContent = "Report pending";
      console.warn("[LakePro] Directory card unavailable", spot.slug, error);
    }
  }));
}

renderDirectory();
