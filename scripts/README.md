# Lake Pro Data Pipeline

Run manually:

```sh
python3 scripts/lakepro_pipeline.py --pretty-print
```

Outputs:

- `data/live/manifest.json`
- `data/live/spots/lake-tahoe.json`
- `data/live/spots/payette-lake.json`
- `data/live/wind_frames/*.json`
- `data/live/map_layers/payette_*.geojson`
- `assets/mile-high-marina-camera.png` when Node + Playwright are available

Install hourly macOS schedule:

```sh
chmod +x scripts/run_lakepro_pipeline.sh
cp scripts/com.lakepro.refresh-data.plist ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/com.lakepro.refresh-data.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.lakepro.refresh-data.plist
launchctl start com.lakepro.refresh-data
```

Notes:

- Weather data comes from the National Weather Service API.
- Payette depth/no-wake layers come from McCall GIS and Valley County GIS.
- Chop height is currently a wind-based proxy, not a measured value.
- Wind-shadow scoring, danger restrictions, and final boating-area grading still need approved model rules and verified hazard polygons.
- The camera refresh script uses Playwright and Google Chrome. If Node/Playwright is unavailable, the scheduled data run still succeeds and leaves the last camera screenshot in place.
