const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  await page.goto("https://milehighmarina.com/webcams/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(6000);
  await page.screenshot({
    path: "assets/mile-high-marina-camera.png",
    clip: { x: 0, y: 473, width: 1280, height: 427 },
  });
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
