// Playwright checks: computed CSS + desktop/mobile screenshots.
// Called by verify.sh.
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:8999';
let fail = 0;
const pass = m => console.log('PASS: ' + m);
const bad  = m => { console.log('FAIL: ' + m); fail = 1; };

const browser = await chromium.launch();

async function hasVisible(page, selector, label) {
  const loc = page.locator(selector);
  const count = await loc.count().catch(() => 0);
  let visible = false;
  for (let i = 0; i < count; i += 1) {
    if (await loc.nth(i).isVisible().catch(() => false)) {
      visible = true;
      break;
    }
  }
  if (visible) pass(label);
  else bad(label.replace(/^(.+): /, '$1: ') + ' missing');
  return visible;
}

for (const [label, width] of [['desktop', 1440], ['mobile', 390]]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  // Home page assertions
  await hasVisible(page, '#heroTitle', `${label}: home hero visible`);
  await hasVisible(page, '#homeFeatureImage', `${label}: live camera feature visible`);
  await hasVisible(page, '#homeLakeLinks .home-lake-link', `${label}: home lake cards rendered`);
  await hasVisible(page, '#homeUsMap .maplibregl-canvas', `${label}: US lake map rendered`);

  const homeCards = await page.locator('#homeLakeLinks .home-lake-link').count();
  if (homeCards >= 6) pass(`${label}: home renders ${homeCards} lake cards`);
  else bad(`${label}: expected at least 6 home lake cards, saw ${homeCards}`);

  const homeMapHeight = await page.$eval('#homeUsMap', el => Math.round(el.getBoundingClientRect().height)).catch(() => 0);
  if (homeMapHeight >= 250) pass(`${label}: home map has usable height (${homeMapHeight}px)`);
  else bad(`${label}: home map height too small (${homeMapHeight}px)`);

  await page.screenshot({ path: `verify-home-${label}.png`, fullPage: true });

  // Spot/report page assertions
  await page.goto(BASE + '/index.html?spot=payette-lake', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  await hasVisible(page, '#pageSpotName', `${label}: spot page title visible`);
  await hasVisible(page, '#forecastStrip .forecast-day', `${label}: 10 day forecast rendered`);
  await hasVisible(page, '#forecastReportDropdown .forecast-report', `${label}: forecast report rendered`);
  await hasVisible(page, '#map .maplibregl-canvas', `${label}: lake map rendered`);
  await hasVisible(page, '#conditionGrade', `${label}: boating grade rendered`);
  await hasVisible(page, '#windFrameSlider', `${label}: wind timeline slider visible`);
  await hasVisible(page, '#cameraCard img', `${label}: camera/map preview card visible`);
  await hasVisible(page, '#todayWeatherCard, #mobileTodayWeatherCard', `${label}: today weather card visible`);

  const grade = await page.locator('#conditionGrade').innerText().catch(() => '');
  if (/^[ABCDF]$/.test(grade.trim())) pass(`${label}: boating grade is a real grade (${grade.trim()})`);
  else bad(`${label}: boating grade invalid (${grade})`);

  const forecastDays = await page.locator('#forecastStrip .forecast-day').count();
  if (forecastDays >= 10) pass(`${label}: forecast renders ${forecastDays} days`);
  else bad(`${label}: expected 10 forecast days, saw ${forecastDays}`);

  const slider = await page.locator('#windFrameSlider').evaluate(el => ({
    min: el.min,
    max: el.max,
    value: el.value
  })).catch(() => null);
  if (slider && Number(slider.max) > Number(slider.min)) {
    pass(`${label}: wind timeline is hydrated (min=${slider.min}, max=${slider.max}, value=${slider.value})`);
  } else {
    bad(`${label}: wind timeline did not hydrate (${JSON.stringify(slider)})`);
  }

  await page.screenshot({ path: `verify-spot-${label}.png`, fullPage: true });
  await page.close();
}

await browser.close();
process.exit(fail);
