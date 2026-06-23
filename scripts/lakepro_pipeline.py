#!/usr/bin/env python3
"""Build Lake Pro live data artifacts.

This pipeline intentionally separates fetched facts from model placeholders:
- Weather/wind data comes from Open-Meteo forecast API.
- Payette ordinance and bathymetry layers are cached from public ArcGIS services.
- Boating ratings are simple placeholders until the wind-shadow/depth/crowding
  model is reviewed and approved.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data" / "live"
SPOTS_DIR = DATA_DIR / "spots"
MAP_LAYERS_DIR = DATA_DIR / "map_layers"
WIND_FRAMES_DIR = DATA_DIR / "wind_frames"

TIMEZONE = "America/Los_Angeles"
USER_AGENT = "LakePro/0.1 foundation data pipeline"


@dataclass(frozen=True)
class Spot:
    slug: str
    name: str
    location: str
    latitude: float
    longitude: float


SPOTS = [
    Spot("lake-tahoe", "Lake Tahoe", "California / Nevada", 39.0968, -120.0324),
    Spot("payette-lake", "Payette Lake", "McCall, Idaho", 44.9406, -116.0910),
]

PAYETTE_LAYER_URLS = {
    "bathymetry_contours": "https://mccallgis.mccall.id.us/mcgis/rest/services/PUB/Payette_Lake_Bathymetry_Contours/FeatureServer/1/query",
    "no_wake_zone": "https://services6.arcgis.com/ikurHvtarxfN6u3u/arcgis/rest/services/WATERWAYS_ORDINANCE/FeatureServer/1/query",
    "shoreline_setback": "https://services6.arcgis.com/ikurHvtarxfN6u3u/arcgis/rest/services/WATERWAYS_ORDINANCE/FeatureServer/0/query",
}


def fetch_json(url: str, timeout: int = 45) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def write_json(path: Path, payload: dict | list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


def round_coordinates(value):
    if isinstance(value, list):
        return [round_coordinates(item) for item in value]
    if isinstance(value, float):
        return round(value, 6)
    return value


def slim_geojson(payload: dict, keep_properties: set[str] | None = None) -> dict:
    features = []
    for feature in payload.get("features", []):
        properties = feature.get("properties") or {}
        if keep_properties is not None:
            properties = {key: properties.get(key) for key in keep_properties if key in properties}
        geometry = feature.get("geometry") or {}
        features.append(
            {
                "type": "Feature",
                "properties": properties,
                "geometry": {
                    **geometry,
                    "coordinates": round_coordinates(geometry.get("coordinates", [])),
                },
            }
        )
    return {"type": "FeatureCollection", "features": features}


def build_url(base: str, params: dict) -> str:
    return base + "?" + urllib.parse.urlencode(params)


def wind_direction_label(degrees: float | None) -> str:
    if degrees is None:
        return ""
    labels = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    return labels[round(float(degrees) / 22.5) % 16]


def crowding_penalty(day: date) -> int:
    summer = day.month in {6, 7, 8}
    weekend = day.weekday() >= 5
    fixed_holiday = (day.month, day.day) in {(7, 4)}
    penalty = 0
    if summer and weekend:
        penalty += 8
    elif weekend:
        penalty += 4
    if fixed_holiday:
        penalty += 12
    return penalty


def grade_from_score(score: int) -> str:
    if score >= 82:
        return "A"
    if score >= 68:
        return "B"
    if score >= 50:
        return "C"
    return "D"


def chop_proxy_ft(wind_mph: float | None, gust_mph: float | None) -> float | None:
    """Placeholder chop estimate.

    This is not measured chop height. It is a conservative proxy from forecast
    wind only, kept separate so the later real model can replace it.
    """
    if wind_mph is None:
        return None
    gust = gust_mph or wind_mph
    return round(max(0.0, (wind_mph - 4.0) * 0.055 + max(0.0, gust - wind_mph) * 0.025), 1)


def window_label(hour: int | None) -> str:
    if hour is None:
        return "Pending"
    if hour < 10:
        return "Early morning"
    if hour < 14:
        return "Late morning"
    if hour < 17:
        return "Afternoon"
    return "Evening"


def best_boating_window_for_day(hourly: dict, day_str: str) -> dict:
    times = hourly.get("time", [])
    winds = hourly.get("wind_speed_10m", [])
    gusts = hourly.get("wind_gusts_10m", [])
    candidates = []

    for start in range(0, max(0, len(times) - 2)):
        chunk_times = times[start : start + 3]
        if len(chunk_times) < 3 or any(timestamp[:10] != day_str for timestamp in chunk_times):
            continue
        hour = int(chunk_times[0][11:13])
        if hour < 6 or hour > 18:
            continue

        wind_chunk = [float(value) for value in winds[start : start + 3] if value is not None]
        gust_chunk = [float(value) for value in gusts[start : start + 3] if value is not None]
        if len(wind_chunk) < 3:
            continue
        avg_wind = sum(wind_chunk) / len(wind_chunk)
        avg_gust = sum(gust_chunk) / len(gust_chunk) if gust_chunk else avg_wind
        candidates.append(
            {
                "start_hour": hour,
                "avg_wind_mph": round(avg_wind, 1),
                "avg_gust_mph": round(avg_gust, 1),
                "score_value": avg_wind + max(0.0, avg_gust - 12.0) * 0.35,
            }
        )

    if not candidates:
        return {"label": "Pending", "avg_wind_mph": None, "avg_gust_mph": None}

    best = min(candidates, key=lambda item: item["score_value"])
    return {
        "label": window_label(best["start_hour"]),
        "avg_wind_mph": best["avg_wind_mph"],
        "avg_gust_mph": best["avg_gust_mph"],
        "start_hour": best["start_hour"],
    }


def best_window(hourly: dict) -> str:
    times = hourly.get("time", [])
    winds = hourly.get("wind_speed_10m", [])
    if not times or not winds:
        return "Pending"

    scored = []
    for timestamp, wind in zip(times, winds):
        if wind is None:
            continue
        hour = int(timestamp[11:13])
        if 5 <= hour <= 18:
            scored.append((float(wind), hour))
    if not scored:
        return "Pending"

    best_hour = min(scored)[1]
    if best_hour < 10:
        return "Early morning"
    if best_hour < 14:
        return "Late morning"
    return "Afternoon"


def build_forecast(spot: Spot) -> dict:
    hourly_fields = [
        "wind_speed_10m",
        "wind_direction_10m",
        "wind_gusts_10m",
        "temperature_2m",
        "precipitation_probability",
    ]
    daily_fields = [
        "weather_code",
        "temperature_2m_max",
        "temperature_2m_min",
        "wind_speed_10m_max",
        "wind_gusts_10m_max",
        "wind_direction_10m_dominant",
        "precipitation_probability_max",
    ]
    url = build_url(
        "https://api.open-meteo.com/v1/forecast",
        {
            "latitude": spot.latitude,
            "longitude": spot.longitude,
            "hourly": ",".join(hourly_fields),
            "daily": ",".join(daily_fields),
            "wind_speed_unit": "mph",
            "temperature_unit": "fahrenheit",
            "timezone": TIMEZONE,
            "forecast_days": 10,
        },
    )
    raw = fetch_json(url)
    daily = raw.get("daily", {})
    hourly = raw.get("hourly", {})
    days = []

    for index, day_str in enumerate(daily.get("time", [])):
        day = date.fromisoformat(day_str)
        wind = daily.get("wind_speed_10m_max", [None])[index]
        gust = daily.get("wind_gusts_10m_max", [None])[index]
        direction = daily.get("wind_direction_10m_dominant", [None])[index]
        precip = daily.get("precipitation_probability_max", [None])[index]
        weather_code = daily.get("weather_code", [None])[index]
        temp_max = daily.get("temperature_2m_max", [None])[index]
        temp_min = daily.get("temperature_2m_min", [None])[index]
        chop = chop_proxy_ft(wind, gust)
        window = best_boating_window_for_day(hourly, day_str)

        score = 92
        if window["avg_wind_mph"] is not None:
            score -= max(0, int(round((float(window["avg_wind_mph"]) - 8) * 5.0)))
        elif wind is not None:
            score -= max(0, int(round((float(wind) - 8) * 4.0)))
        if window["avg_gust_mph"] is not None:
            score -= max(0, int(round((float(window["avg_gust_mph"]) - 14) * 2.0)))
        elif gust is not None:
            score -= max(0, int(round((float(gust) - 14) * 1.5)))
        if precip is not None:
            score -= max(0, int(round((float(precip) - 45) * 0.2)))
        score -= crowding_penalty(day)
        score = max(0, min(100, score))

        days.append(
            {
                "date": day_str,
                "grade": grade_from_score(score),
                "score": score,
                "wind_speed_max_mph": wind,
                "wind_gust_max_mph": gust,
                "wind_direction_deg": direction,
                "wind_direction_label": wind_direction_label(direction),
                "precipitation_probability_max": precip,
                "weather_code": weather_code,
                "temperature_2m_max": temp_max,
                "temperature_2m_min": temp_min,
                "chop_proxy_ft": chop,
                "best_window": window["label"],
                "best_window_wind_mph": window["avg_wind_mph"],
                "best_window_gust_mph": window["avg_gust_mph"],
                "crowding_penalty": crowding_penalty(day),
                "summary": "Window-based placeholder rating from live wind + crowding until Lake Pro model is approved.",
            }
        )

    latest = days[0] if days else {}
    return {
        "spot": spot.__dict__,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": {
            "weather": "Open-Meteo Forecast API",
            "url": url,
        },
        "latest": {
            **latest,
            "best_window": latest.get("best_window") or best_window(hourly),
            "report": "Live wind forecast is connected. Wind-shadow, depth scoring, danger restrictions, and final chop model are pending.",
        },
        "ten_day": days,
        "hourly": hourly,
        "model_status": {
            "wind_shadow": "pending",
            "depth_scoring": "pending",
            "danger_restrictions": "pending",
            "chop_height": "proxy_only_not_measured",
        },
    }


def build_wind_frame(spot: Spot, forecast: dict) -> dict:
    hourly = forecast.get("hourly", {})
    times = hourly.get("time", [])[:24]
    speeds = hourly.get("wind_speed_10m", [])[:24]
    directions = hourly.get("wind_direction_10m", [])[:24]
    return {
        "spot_slug": spot.slug,
        "generated_at": forecast.get("generated_at"),
        "status": "live_weather_stub_grid",
        "note": "Regional wind-frame scaffold uses live Open-Meteo point forecast. Spatial cropped grid still pending.",
        "frames": [
            {
                "time": timestamp,
                "wind_speed_mph": speed,
                "wind_direction_deg": direction,
                "wind_direction_label": wind_direction_label(direction),
            }
            for timestamp, speed, direction in zip(times, speeds, directions)
        ],
    }


def refresh_map_layers() -> dict:
    results = {}
    common_params = {
        "where": "1=1",
        "outFields": "*",
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "geojson",
    }
    for name, base in PAYETTE_LAYER_URLS.items():
        url = build_url(base, common_params)
        try:
            payload = fetch_json(url)
            if name == "bathymetry_contours":
                payload = slim_geojson(payload, {"Contour"})
            else:
                payload = slim_geojson(payload, {"Label", "Notes"})
            write_json(MAP_LAYERS_DIR / f"payette_{name}.geojson", payload)
            results[name] = {"status": "ok", "features": len(payload.get("features", [])), "url": url}
        except Exception as exc:
            results[name] = {"status": "failed", "error": str(exc), "url": url}
    return results


def run_pipeline() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    spot_summaries = []
    failures = []

    for spot in SPOTS:
        try:
            forecast = build_forecast(spot)
            write_json(SPOTS_DIR / f"{spot.slug}.json", forecast)
            write_json(WIND_FRAMES_DIR / f"{spot.slug}.json", build_wind_frame(spot, forecast))
            latest = forecast.get("latest", {})
            spot_summaries.append(
                {
                    "slug": spot.slug,
                    "name": spot.name,
                    "grade": latest.get("grade"),
                    "score": latest.get("score"),
                    "wind_speed_max_mph": latest.get("wind_speed_max_mph"),
                    "best_window": latest.get("best_window"),
                }
            )
        except Exception as exc:
            failures.append({"spot": spot.slug, "error": str(exc)})

    map_layers = refresh_map_layers()
    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "spots": spot_summaries,
        "map_layers": map_layers,
        "failures": failures,
    }
    write_json(DATA_DIR / "manifest.json", manifest)
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Build Lake Pro live JSON data artifacts.")
    parser.add_argument("--pretty-print", action="store_true", help="Print generated manifest after running.")
    args = parser.parse_args()
    status = run_pipeline()
    if args.pretty_print:
        print((DATA_DIR / "manifest.json").read_text())
    return status


if __name__ == "__main__":
    raise SystemExit(main())
