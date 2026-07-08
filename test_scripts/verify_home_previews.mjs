#!/usr/bin/env node

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function loadPlaywright() {
  try {
    return require("playwright");
  } catch (error) {
    const fallback = process.env.PLAYWRIGHT_NODE_MODULE_DIR
      ? `${process.env.PLAYWRIGHT_NODE_MODULE_DIR}/playwright`
      : "/Users/patduds/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright";
    return require(fallback);
  }
}

const { chromium } = loadPlaywright();

const LIVE_BASE = "https://patdudley.github.io/Lake-Pro/";
const PAGES = [
  { name: "home", url: LIVE_BASE },
  { name: "directory", url: `${LIVE_BASE}lakes.html` },
];
const SIMULATE_CAMERA_ERROR = process.argv.includes("--simulate-camera-error");

function decodeImageSource(src) {
  if (!src) return "";
  if (!src.startsWith("data:image/svg+xml")) return src;
  const encoded = src.includes(",") ? src.slice(src.indexOf(",") + 1) : src;
  try {
    return decodeURIComponent(encoded);
  } catch (error) {
    return encoded;
  }
}

async function inspectPage(browser, pageConfig) {
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  const previewRequests = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.endsWith("home-previews.json")) {
      previewRequests.push(url);
    }
  });

  const url = `${pageConfig.url}${pageConfig.url.includes("?") ? "&" : "?"}verify=${Date.now()}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  const selector = pageConfig.name === "directory" ? ".directory-lake-card" : ".home-lake-link";
  const rows = await page.$$eval(selector, (cards) => {
    function decode(src) {
      if (!src) return "";
      if (!src.startsWith("data:image/svg+xml")) return src;
      const encoded = src.includes(",") ? src.slice(src.indexOf(",") + 1) : src;
      try {
        return decodeURIComponent(encoded);
      } catch (error) {
        return encoded;
      }
    }

    return cards.map((card) => {
      const img = card.querySelector("img");
      const slug = card.dataset.spot || card.dataset.slug || "";
      const src = img?.currentSrc || img?.src || "";
      const decoded = decode(src);
      const camera = img?.dataset.camera === "true";
      let classification = "EMPTY";
      if (decoded.includes("Map preview")) {
        classification = "PLACEHOLDER";
      } else if (decoded.includes(`water-${slug}`) && decoded.includes("<polygon")) {
        classification = "REAL";
      } else if (src && !src.startsWith("data:image/svg+xml")) {
        classification = "CAMERA";
      } else if (src) {
        classification = "UNKNOWN";
      }
      return {
        slug,
        camera,
        classification,
        first80: decoded.slice(0, 80),
        src,
      };
    });
  });

  let cameraError = null;
  if (SIMULATE_CAMERA_ERROR && pageConfig.name === "home") {
    cameraError = await page.evaluate(async () => {
      const card = [...document.querySelectorAll(".home-lake-link")].find((item) => {
        const img = item.querySelector("img[data-camera='true']");
        return Boolean(img);
      });
      if (!card) return null;
      const img = card.querySelector("img");
      const slug = card.dataset.spot || "";
      const before = img.src;
      img.dispatchEvent(new Event("error"));
      await new Promise((resolve) => setTimeout(resolve, 800));
      const after = img.src;
      function decode(src) {
        if (!src) return "";
        if (!src.startsWith("data:image/svg+xml")) return src;
        const encoded = src.includes(",") ? src.slice(src.indexOf(",") + 1) : src;
        try {
          return decodeURIComponent(encoded);
        } catch (error) {
          return encoded;
        }
      }
      const decodedAfter = decode(after);
      let classification = "EMPTY";
      if (decodedAfter.includes("Map preview")) {
        classification = "PLACEHOLDER";
      } else if (decodedAfter.includes(`water-${slug}`) && decodedAfter.includes("<polygon")) {
        classification = "REAL";
      } else if (after && !after.startsWith("data:image/svg+xml")) {
        classification = "CAMERA";
      } else if (after) {
        classification = "UNKNOWN";
      }
      return {
        slug,
        before: decode(before).slice(0, 220),
        after: decodedAfter.slice(0, 220),
        classification,
      };
    });
  }

  const nonCamera = rows.filter((row) => !row.camera);
  const realCount = nonCamera.filter((row) => row.classification === "REAL").length;
  const placeholderCount = nonCamera.filter((row) => row.classification === "PLACEHOLDER").length;
  const emptyCount = nonCamera.filter((row) => row.classification === "EMPTY").length;
  const unknownCount = nonCamera.filter((row) => row.classification === "UNKNOWN").length;
  const pass = previewRequests.length === 1
    && nonCamera.length > 0
    && realCount === nonCamera.length
    && placeholderCount === 0
    && emptyCount === 0
    && unknownCount === 0;

  await page.close();

  return {
    name: pageConfig.name,
    url,
    previewRequests,
    rows,
    nonCameraCount: nonCamera.length,
    realCount,
    placeholderCount,
    emptyCount,
    unknownCount,
    pass,
    cameraError,
  };
}

function printResult(result) {
  console.log(`\n=== ${result.name.toUpperCase()} ===`);
  console.log(`URL: ${result.url}`);
  console.log(`home-previews.json request count: ${result.previewRequests.length}`);
  result.previewRequests.forEach((url, index) => {
    console.log(`home-previews.json request ${index + 1}: ${url}`);
  });
  console.log("slug | camera? | classification | first 80 chars of decoded src");
  result.rows.forEach((row) => {
    console.log(`${row.slug} | ${row.camera ? "true" : "false"} | ${row.classification} | ${row.first80}`);
  });
  console.log(`PASS/FAIL: ${result.pass ? "PASS" : "FAIL"} | non-camera REAL=${result.realCount} PLACEHOLDER=${result.placeholderCount} EMPTY=${result.emptyCount} UNKNOWN=${result.unknownCount} TOTAL=${result.nonCameraCount}`);
  if (result.cameraError) {
    console.log("SIMULATED CAMERA ERROR:");
    console.log(`slug: ${result.cameraError.slug}`);
    console.log(`before decoded src: ${result.cameraError.before}`);
    console.log(`after decoded src: ${result.cameraError.after}`);
    console.log(`after classification: ${result.cameraError.classification}`);
  }
}

const browser = await chromium.launch({ headless: true });
const results = [];
for (const pageConfig of PAGES) {
  results.push(await inspectPage(browser, pageConfig));
}
await browser.close();

results.forEach(printResult);
const allPass = results.every((result) => result.pass);
if (SIMULATE_CAMERA_ERROR) {
  const simulated = results.find((result) => result.cameraError)?.cameraError;
  if (!simulated || simulated.classification !== "REAL") {
    process.exitCode = 1;
  }
} else if (!allPass) {
  process.exitCode = 1;
}
