# Lake Pro Data Pipeline

Run manually:

```sh
python3 scripts/lakepro_pipeline.py --pretty-print
```

Outputs:

- `data/live/manifest.json`
- `data/live/spots/lake-tahoe.json`
- `data/live/spots/payette-lake.json`
- `data/live/spots/*.json` for the full Lake Pro catalog
- `data/live/wind_frames/*.json`
- `data/live/map_layers/payette_*.geojson`
- `data/live/map_layers/*_shoreline.geojson` for deterministic lake-surface overlays
- `assets/cameras/{spot-slug}.png` for catalog webcam sources when Node + Playwright are available
- `reports/camera-audit.md` and `reports/camera-audit.json` showing captured, failed, and missing camera sources

Refresh shoreline masks manually:

```sh
python3 scripts/refresh_shoreline_masks.py --only-missing
```

Install macOS schedule. This refreshes weather data and lake camera screenshots
hourly from 7:00 AM through 10:00 PM local time:

```sh
chmod +x scripts/run_lakepro_pipeline.sh
mkdir -p ~/Library/LaunchAgents
cp scripts/com.lakepro.refresh-data.plist ~/Library/LaunchAgents/
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.lakepro.refresh-data.plist 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.lakepro.refresh-data.plist
launchctl kickstart -k "gui/$(id -u)/com.lakepro.refresh-data"
```

Notes:

- Tahoe and Payette weather data comes from the National Weather Service API, with Open-Meteo fallback.
- Catalog lake weather data comes from Open-Meteo until each lake has approved lake-specific model assets.
- Payette depth/no-wake layers come from McCall GIS and Valley County GIS.
- Chop height is currently a wind-based proxy, not a measured value.
- Wind-shadow scoring, danger restrictions, and final boating-area grading still need approved model rules and verified hazard polygons.
- The camera refresh script uses Playwright and Google Chrome. If Node/Playwright is unavailable, the scheduled data run still succeeds and leaves the last camera screenshots in place.
- If macOS blocks the LaunchAgent with `Operation not permitted`, move the repo out of `Documents` or grant Full Disk Access to the shell used by launchd. The script itself can still be run manually from Terminal.
