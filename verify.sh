#!/usr/bin/env bash
# Local verification harness. Serves the site, runs curl + Playwright checks, exits 0 (pass) / 1 (fail).
# Usage: ./verify.sh
set -u
PORT=8999
FAIL=0
NODE_BIN=${NODE_BIN:-}
if [ -z "$NODE_BIN" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN=node
  elif [ -x "/Users/patduds/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]; then
    NODE_BIN="/Users/patduds/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
  else
    NODE_BIN=node
  fi
fi

# --- start local server ---
python3 -m http.server "$PORT" >/dev/null 2>&1 &
SERVER=$!
sleep 1
BASE="http://localhost:$PORT"
cleanup() { kill "$SERVER" 2>/dev/null; }
trap cleanup EXIT

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

# ============================================================
# 1. CURL CHECKS
# ============================================================
HTML=$(curl -s "$BASE/index.html")

# Lake Pro structural hooks
echo "$HTML" | grep -q 'id="homeUsMap"'              && pass "home US map hook present"       || fail "home US map hook missing"
echo "$HTML" | grep -q 'id="homeLakeLinks"'          && pass "home lake cards hook present"    || fail "home lake cards hook missing"
echo "$HTML" | grep -q 'id="forecastStrip"'          && pass "10 day forecast hook present"    || fail "10 day forecast hook missing"
echo "$HTML" | grep -q 'id="map"'                    && pass "lake map hook present"          || fail "lake map hook missing"
echo "$HTML" | grep -q 'id="windFrameSlider"'        && pass "wind timeline hook present"     || fail "wind timeline hook missing"
echo "$HTML" | grep -q 'src/forecast/app.js'         && pass "Lake Pro app bundle referenced" || fail "Lake Pro app bundle missing"

# data shape: Lake Pro live summary should exist and include spot records
SUMMARY=$(curl -s "$BASE/data/live/home-summary.json")
if printf '%s' "$SUMMARY" | grep -q '"spots"' && printf '%s' "$SUMMARY" | grep -q '"slug"'; then
  pass "home-summary live data shape present"
else
  fail "home-summary live data shape missing"
fi

# ============================================================
# 2. PLAYWRIGHT CHECKS  (computed CSS + screenshots)
# ============================================================
"$NODE_BIN" verify_browser.mjs "$BASE" || FAIL=1

# ============================================================
echo "----------------------------------------"
[ "$FAIL" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "CHECKS FAILED"
exit "$FAIL"
