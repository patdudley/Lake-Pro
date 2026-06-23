#!/bin/sh
set -eu
cd "/Users/patduds/Documents/Lake Pro"
/usr/bin/python3 scripts/lakepro_pipeline.py >> logs/lakepro_pipeline.out.log 2>> logs/lakepro_pipeline.err.log
if command -v node >/dev/null 2>&1; then
  NODE_PATH="${NODE_PATH:-}" node scripts/capture_mile_high_camera.js >> logs/lakepro_pipeline.out.log 2>> logs/lakepro_pipeline.err.log || true
fi
