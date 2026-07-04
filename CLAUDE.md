# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Lake Pro — live wake-boating conditions, forecasts, and webcam views for ~112 lakes. A static site served by GitHub Pages **directly from the root of `main`**: every commit to `main` is a production deploy. There is no build step, no bundler, no framework, no staging environment, and no test gate on push.

`FOUNDATION_PROGRESS.md` is the build history. The boating "model" (grades, chop, crowding) is an explicitly labeled placeholder — wind-shadow scoring, depth scoring, and danger restrictions are pending approved model rules. Don't present placeholder grades as a finished model, and don't silently change grading rules; they are Pat's product decisions.

## Commands

```bash
python3 scripts/lakepro_pipeline.py --pretty-print   # full data refresh (network: NWS + Open-Meteo for all 112 lakes, ~5-10 min)
python3 scripts/refresh_shoreline_masks.py --only-missing --slug <slug>   # OSM shoreline masks (rate-limited; be polite to Overpass/Nominatim)
node scripts/capture_lake_cameras.js                 # Playwright webcam screenshots (needs `npm install --no-save playwright`)
python3 -m http.server 4174                          # serve the site locally from repo root
python3 -m unittest discover test_scripts -v        # unit tests for pipeline pure functions
```

The pipeline exits non-zero when any lake fails to fetch; per-lake failures are recorded in `data/live/manifest.json` under `failures`. Check there first when a run is red. Failed lakes get one retry pass after a pause (skipped when so many fail that the provider itself is down), keep their last-good JSON either way, and Tahoe/Payette publish NWS-only days when just the Open-Meteo 10-day fill is unreachable (`source.daily_fill_error`). A red run therefore means failures persisted through retries — not lost data.

## Architecture

One scheduled GitHub Actions workflow (`refresh-live-data.yml`, hourly, gated to 7am–10pm Pacific) commits generated content straight to `main`:

1. `scripts/lakepro_pipeline.py` fetches NWS forecasts for `liveReady` lakes (Tahoe, Payette) with Open-Meteo fallback, Open-Meteo for the rest of the catalog, plus Payette GIS ordinance/bathymetry layers. It writes `data/live/spots/*.json`, `data/live/wind_frames/*.json`, `data/live/home-summary.json`, and `data/live/manifest.json`.
2. `scripts/capture_lake_cameras.js` screenshots every catalog webcam into `assets/cameras/` and writes `reports/camera-audit.{json,md}`.
3. The commit step runs even when the pipeline reports partial failures — one flaky lake must not discard the other lakes' fresh data. Don't re-gate the commit on pipeline success.

The frontend (`index.html` + `src/forecast/app.js`, `lakes.html` + `src/forecast/lakes.js`) fetches only files the workflow commits. Key consequences:

- **Cache busting is manual**: JS/CSS load with `?v=name-date` query strings in the HTML. Bump them when you change a file, or browsers keep the old one. ES-module imports (`lakeCatalog.js` etc.) have no version string and rely on GitHub Pages ETags.
- **`src/spots/lakeCatalog.js` is both source and generated data.** It is a pure JSON array wrapped in `export const lakeCatalog =`, parsed by bracket-slicing in `lakepro_pipeline.py`, `refresh_shoreline_masks.py`, and `capture_lake_cameras.js`. Keep it machine-generated (via `write_catalog_rows`) — hand edits that break pure-JSON parsing break the whole pipeline. The pipeline regenerates its `previewSvg` entries from checked-in shoreline masks; the CI workflow does not commit this file.
- **Camera visibility is a frontend whitelist**, not the capture list: `src/forecast/cameras.js` (`approvedCameraOverrides`, `capturedCameraSlugs`, `unusableCameraSlugs`) controls what users see. Capturing a webcam does not publish it; add the slug to the whitelist only for Pat-approved sources.
- Grading/scoring logic is intentionally duplicated between Python (`lakepro_pipeline.py`) and JS (`app.js`: `gradeFromScore`, `windGradeCap`, `chopProxyFt`, heat caps). If you change thresholds in one, change the other in the same commit.

`scripts/run_lakepro_pipeline.sh` + `scripts/com.lakepro.refresh-data.plist` are the launchd hourly schedule for Pat's Mac — a parallel refresh path to GitHub Actions, not used by CI.

## Git workflow

- `main` moves hourly under you (bot data commits). `git pull --rebase` before pushing.
- Don't hand-commit generated artifacts (`data/live/*`, `assets/cameras/*`, `reports/camera-audit.*`) in feature commits — let the workflow own those paths.
- Keep large binaries out: `.screenshots/` and hourly webcam PNG commits have already bloated the repo (~190 MB `.git`). Prefer linking or pruning over adding more.
- After changing the pipeline or workflow, don't wait for the cron: trigger **Actions → "Refresh live Lake Pro data" → Run workflow**, then confirm a fresh `generated_at` in `data/live/manifest.json` on `main` and an empty (or explained) `failures` list.

## Known issues / open work

- Repo growth: hourly PNG screenshot commits are unbounded; needs a retention or external-storage decision.
- Payette-specific map layers and the Payette/Tahoe gradient centers are hardcoded in `app.js`; other lakes use generic fallbacks.
