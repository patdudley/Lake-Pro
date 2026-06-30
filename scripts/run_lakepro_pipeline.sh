#!/bin/sh
set -eu
cd "/Users/patduds/Documents/Lake Pro"
/usr/bin/python3 scripts/lakepro_pipeline.py >> logs/lakepro_pipeline.out.log 2>> logs/lakepro_pipeline.err.log
NODE_RUNTIME="/Users/patduds/.cache/codex-runtimes/codex-primary-runtime/dependencies/node"
NODE_BIN="$NODE_RUNTIME/bin/node"
if [ -x "$NODE_BIN" ]; then
  NODE_PATH="$NODE_RUNTIME/node_modules" "$NODE_BIN" scripts/capture_lake_cameras.js >> logs/lakepro_pipeline.out.log 2>> logs/lakepro_pipeline.err.log || true
elif command -v node >/dev/null 2>&1; then
  NODE_PATH="${NODE_PATH:-}" node scripts/capture_lake_cameras.js >> logs/lakepro_pipeline.out.log 2>> logs/lakepro_pipeline.err.log || true
fi
