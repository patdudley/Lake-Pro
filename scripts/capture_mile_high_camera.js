const { chromium } = require("playwright");
const fs = require("fs");

function launchOptions() {
  const localChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    || (fs.existsSync(localChrome) ? localChrome : "");
  return executablePath
    ? { headless: true, executablePath }
    : { headless: true };
}

(async () => {
  const browser = await chromium.launch(launchOptions());
  await captureMileHigh(browser);
  await captureEdgewood(browser);
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function captureMileHigh(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  await page.goto("https://milehighmarina.com/webcams/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(6000);
  await page.screenshot({
    path: "assets/mile-high-marina-camera.png",
    clip: { x: 0, y: 473, width: 1280, height: 427 },
  });
  await page.close();
}

async function captureEdgewood(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto("https://edgewoodtahoe.com/webcam/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3000);
  const acceptCookies = page.locator("#CybotCookiebotDialogBodyButtonAccept");
  if (await acceptCookies.isVisible().catch(() => false)) {
    await acceptCookies.click();
  }
  await page.waitForTimeout(4000);
  const cameraFrame = page.locator("iframe[title*='Embedded camera'], iframe[src*='earthcam']").first();
  await cameraFrame.screenshot({ path: "assets/edgewood-tahoe-camera.png" });
  await page.close();
}
