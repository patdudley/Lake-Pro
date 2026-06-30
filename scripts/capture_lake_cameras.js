const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CATALOG_PATH = path.join(ROOT, "src", "spots", "lakeCatalog.js");
const CAMERA_DIR = path.join(ROOT, "assets", "cameras");
const REPORT_DIR = path.join(ROOT, "reports");
const AUDIT_PATH = path.join(REPORT_DIR, "camera-audit.json");
const SUMMARY_PATH = path.join(REPORT_DIR, "camera-audit.md");

function launchOptions() {
  const localChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    || (fs.existsSync(localChrome) ? localChrome : "");
  return executablePath
    ? { headless: true, executablePath }
    : { headless: true };
}

function loadCatalog() {
  const source = fs.readFileSync(CATALOG_PATH, "utf8");
  const start = source.indexOf("[");
  const end = source.lastIndexOf("];") + 1;
  const json = source.slice(start, end).replace(/,\s*]/g, "]");
  return JSON.parse(json);
}

function cameraImagePath(slug) {
  return path.join(CAMERA_DIR, `${slug}.png`);
}

function cameraImageUrl(slug) {
  return `assets/cameras/${slug}.png`;
}

async function dismissCommonOverlays(page) {
  const selectors = [
    "button:has-text('Accept')",
    "button:has-text('I Accept')",
    "button:has-text('Agree')",
    "button:has-text('Continue')",
    "button:has-text('Close')",
    "[aria-label='Close']",
    ".close",
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click({ timeout: 1500 }).catch(() => {});
      await page.waitForTimeout(500);
    }
  }
}

async function bestCameraTarget(page, spot) {
  const candidates = [
    "iframe[src*='earthcam']",
    "iframe[src*='hdontap']",
    "iframe[src*='youtube']",
    "iframe[src*='weatherstem']",
    ...(spot.slug === "canyon-lake" ? ["iframe"] : []),
    "video",
    "canvas",
    "img[src*='webcam']",
    "img[src*='camera']",
    "img",
    "main",
    "body",
  ];
  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      const box = await locator.boundingBox().catch(() => null);
      if (box && box.width >= 320 && box.height >= 180) return locator;
    }
  }
  return page.locator("body");
}

async function captureCamera(browser, spot) {
  const outputPath = cameraImagePath(spot.slug);
  const page = await browser.newPage({
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(9000);
  const startedAt = new Date().toISOString();
  try {
    await page.goto(spot.webcam.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(5500);
    await dismissCommonOverlays(page);
    await page.waitForTimeout(1500);
    const target = await bestCameraTarget(page, spot);
    await target.screenshot({ path: outputPath });
    const stat = fs.statSync(outputPath);
    return {
      slug: spot.slug,
      name: spot.name,
      location: spot.location,
      status: stat.size > 10000 ? "captured" : "suspect",
      sourceUrl: spot.webcam.url,
      label: spot.webcam.label,
      imageUrl: cameraImageUrl(spot.slug),
      bytes: stat.size,
      checkedAt: startedAt,
    };
  } catch (error) {
    return {
      slug: spot.slug,
      name: spot.name,
      location: spot.location,
      status: "failed",
      sourceUrl: spot.webcam.url,
      label: spot.webcam.label,
      error: error.message,
      checkedAt: startedAt,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

function writeAudit(results, noSource) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    captured: results.filter((item) => item.status === "captured"),
    suspect: results.filter((item) => item.status === "suspect"),
    failed: results.filter((item) => item.status === "failed"),
    noSource,
  };
  fs.writeFileSync(AUDIT_PATH, `${JSON.stringify(payload, null, 2)}\n`);

  const lines = [
    "# Lake Pro Camera Audit",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `- Captured: ${payload.captured.length}`,
    `- Suspect: ${payload.suspect.length}`,
    `- Failed: ${payload.failed.length}`,
    `- No catalog webcam source yet: ${payload.noSource.length}`,
    "",
    "## Captured",
    ...payload.captured.map((item) => `- ${item.name} (${item.location}) — ${item.label}: ${item.sourceUrl}`),
    "",
    "## Failed Or Needs Manual Work",
    ...[...payload.suspect, ...payload.failed].map((item) => `- ${item.name} (${item.location}) — ${item.label}: ${item.sourceUrl}${item.error ? ` — ${item.error}` : ""}`),
    "",
    "## No Verified Webcam Source Yet",
    ...payload.noSource.map((item) => `- ${item.name} (${item.location})`),
    "",
  ];
  fs.writeFileSync(SUMMARY_PATH, `${lines.join("\n")}\n`);
}

(async () => {
  fs.mkdirSync(CAMERA_DIR, { recursive: true });
  const catalog = loadCatalog();
  const cameraSpots = catalog.filter((spot) => spot.webcam?.url);
  const noSource = catalog
    .filter((spot) => !spot.webcam?.url)
    .map((spot) => ({ slug: spot.slug, name: spot.name, location: spot.location }));
  const browser = await chromium.launch(launchOptions());
  const results = [];
  for (const spot of cameraSpots) {
    console.log(`[camera] ${spot.slug} ${spot.webcam.url}`);
    results.push(await captureCamera(browser, spot));
  }
  await browser.close();
  writeAudit(results, noSource);
  console.log(`Wrote ${AUDIT_PATH}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
