#!/usr/bin/env python3
"""Build Lake Pro live data artifacts.

This pipeline intentionally separates fetched facts from model placeholders:
- Weather/wind data comes from the National Weather Service API.
- Payette ordinance and bathymetry layers are cached from public ArcGIS services.
- Boating ratings are simple placeholders until the wind-shadow/depth/crowding
  model is reviewed and approved.
"""

from __future__ import annotations

import argparse
import json
import math
import re
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
DAYLIGHT_WAKE_START_HOUR = 7
DAYLIGHT_WAKE_END_HOUR = 19


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


def wind_direction_degrees(label: str | None) -> int | None:
    if not label:
        return None
    labels = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    value = label.strip().upper()
    if value not in labels:
        return None
    return labels.index(value) * 22


def parse_wind_mph(value: str | None) -> float | None:
    if not value:
        return None
    numbers = [float(item) for item in re.findall(r"\d+(?:\.\d+)?", value)]
    return max(numbers) if numbers else None


def precip_value(period: dict) -> float:
    value = (period.get("probabilityOfPrecipitation") or {}).get("value")
    return float(value or 0)


def nws_weather_code(short_forecast: str, precip: float) -> int:
    text = (short_forecast or "").lower()
    if "thunder" in text:
        return 95
    if "snow" in text:
        return 75
    if "rain" in text or "shower" in text:
        return 80
    if precip >= 55:
        return 80
    if "sunny" in text and "partly" not in text and "mostly" not in text:
        return 0
    if "partly" in text or "mostly sunny" in text:
        return 2
    if "cloud" in text or "overcast" in text:
        return 3
    return 1


def fetch_nws_forecast(spot: Spot) -> dict:
    points_url = f"https://api.weather.gov/points/{spot.latitude},{spot.longitude}"
    points = fetch_json(points_url)
    forecast_url = points["properties"]["forecast"]
    hourly_url = points["properties"]["forecastHourly"]
    forecast = fetch_json(forecast_url)
    hourly = fetch_json(hourly_url)
    return {
        "points_url": points_url,
        "forecast_url": forecast_url,
        "hourly_url": hourly_url,
        "forecast": forecast,
        "hourly": hourly,
    }


def fetch_open_meteo_daily(spot: Spot) -> dict:
    params = {
        "latitude": spot.latitude,
        "longitude": spot.longitude,
        "daily": ",".join(
            [
                "weather_code",
                "temperature_2m_max",
                "temperature_2m_min",
                "precipitation_probability_max",
                "wind_speed_10m_max",
                "wind_direction_10m_dominant",
            ]
        ),
        "hourly": ",".join(
            [
                "temperature_2m",
                "precipitation_probability",
                "wind_speed_10m",
                "wind_gusts_10m",
                "wind_direction_10m",
                "weather_code",
            ]
        ),
        "temperature_unit": "fahrenheit",
        "wind_speed_unit": "mph",
        "timezone": TIMEZONE,
        "forecast_days": 10,
    }
    url = build_url("https://api.open-meteo.com/v1/forecast", params)
    payload = fetch_json(url)
    payload["url"] = url
    return payload


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
    if score >= 85:
        return "A"
    if score >= 72:
        return "B"
    if score >= 60:
        return "C"
    if score >= 48:
        return "D"
    return "F"


def top_score_for_grade(grade: str) -> int:
    if grade == "A":
        return 100
    if grade == "B":
        return 84
    if grade == "C":
        return 71
    if grade == "D":
        return 59
    return 47


def wind_grade_cap(speed: float | None) -> str:
    if speed is None:
        return "A"
    value = float(speed)
    if value >= 16:
        return "F"
    if value >= 12:
        return "D"
    if value >= 8:
        return "C"
    if value >= 5:
        return "B"
    return "A"


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


def is_daylight_wake_hour(hour: int) -> bool:
    return DAYLIGHT_WAKE_START_HOUR <= hour <= DAYLIGHT_WAKE_END_HOUR


def score_boating_window(
    *,
    day: date,
    avg_wind: float | None,
    avg_gust: float | None,
    max_precip: float | None,
    day_temp_max: float | int | None,
    weather_code: int | float | None,
) -> tuple[int, int, list[str]]:
    score = 94
    if avg_wind is not None:
        score -= max(0, int(round((float(avg_wind) - 4.5) * 4.7)))
    if avg_gust is not None:
        score -= max(0, int(round((float(avg_gust) - 10) * 1.8)))
    if max_precip is not None:
        score -= max(0, int(round((float(max_precip) - 30) * 0.25)))
    score -= crowding_penalty(day)
    score = max(0, min(100, score))
    window_stays_dry = max_precip is not None and float(max_precip) <= 25
    return apply_grade_caps(
        score,
        day,
        day_temp_max,
        max_precip,
        weather_code,
        avg_wind,
        window_stays_dry,
    )


def best_boating_window_for_day(hourly: dict, day_str: str, day_temp_max: float | int | None = None) -> dict:
    times = hourly.get("time", [])
    winds = hourly.get("wind_speed_10m", [])
    gusts = hourly.get("wind_gusts_10m", [])
    precipitation = hourly.get("precipitation_probability", [])
    temperatures = hourly.get("temperature_2m", [])
    weather_codes = hourly.get("weather_code", [])
    short_forecasts = hourly.get("short_forecast", [])
    candidates = []
    day = date.fromisoformat(day_str)

    for minimum_hours in (3, 1):
        for start in range(0, len(times)):
            chunk_indices = []
            for index in range(start, min(len(times), start + 3)):
                if times[index][:10] != day_str:
                    break
                chunk_indices.append(index)
            chunk_times = [times[index] for index in chunk_indices]
            if len(chunk_times) < minimum_hours:
                continue
            hours = [int(timestamp[11:13]) for timestamp in chunk_times]
            if not all(is_daylight_wake_hour(hour) for hour in hours):
                continue

            wind_chunk = [float(winds[index]) for index in chunk_indices if index < len(winds) and winds[index] is not None]
            gust_chunk = [float(gusts[index]) for index in chunk_indices if index < len(gusts) and gusts[index] is not None]
            precip_chunk = [float(precipitation[index]) for index in chunk_indices if index < len(precipitation) and precipitation[index] is not None]
            temp_chunk = [float(temperatures[index]) for index in chunk_indices if index < len(temperatures) and temperatures[index] is not None]
            if len(wind_chunk) < minimum_hours:
                continue
            avg_wind = sum(wind_chunk) / len(wind_chunk)
            avg_gust = sum(gust_chunk) / len(gust_chunk) if gust_chunk else avg_wind
            max_precip = max(precip_chunk) if precip_chunk else None
            window_temp_max = max(temp_chunk) if temp_chunk else day_temp_max
            window_weather_code = None
            for index in chunk_indices:
                precip_value_for_hour = precipitation[index] if index < len(precipitation) else None
                if max_precip is not None and precip_value_for_hour == max_precip:
                    if index < len(weather_codes):
                        window_weather_code = weather_codes[index]
                    elif index < len(short_forecasts):
                        window_weather_code = nws_weather_code(short_forecasts[index], max_precip)
                    break
            score, score_before_wind_cap, grade_caps = score_boating_window(
                day=day,
                avg_wind=avg_wind,
                avg_gust=avg_gust,
                max_precip=max_precip,
                day_temp_max=day_temp_max if day_temp_max is not None else window_temp_max,
                weather_code=window_weather_code,
            )
            candidates.append(
                {
                    "start_hour": hours[0],
                    "avg_wind_mph": round(avg_wind, 1),
                    "avg_gust_mph": round(avg_gust, 1),
                    "max_precip_probability": max_precip,
                    "temperature_2m_max": round(window_temp_max) if window_temp_max is not None else None,
                    "weather_code": window_weather_code,
                    "score": score,
                    "score_before_wind_cap": score_before_wind_cap,
                    "grade_caps": grade_caps,
                }
            )
        if candidates:
            break

    if not candidates:
        return {
            "label": "Pending",
            "avg_wind_mph": None,
            "avg_gust_mph": None,
            "max_precip_probability": None,
            "score": None,
            "score_before_wind_cap": None,
            "grade_caps": [],
        }

    best = max(candidates, key=lambda item: (item["score"], -float(item["avg_wind_mph"] or 99), -item["start_hour"]))
    return {
        "label": window_label(best["start_hour"]),
        "avg_wind_mph": best["avg_wind_mph"],
        "avg_gust_mph": best["avg_gust_mph"],
        "max_precip_probability": best["max_precip_probability"],
        "start_hour": best["start_hour"],
        "score": best["score"],
        "score_before_wind_cap": best["score_before_wind_cap"],
        "grade_caps": best["grade_caps"],
        "weather_code": best["weather_code"],
        "temperature_2m_max": best["temperature_2m_max"],
    }


def is_rainy_weather_code(code: int | float | None) -> bool:
    if code is None:
        return False
    value = int(code)
    return 51 <= value <= 67 or 80 <= value <= 82 or value >= 95


def cap_score(score: int, cap: int) -> int:
    return min(score, cap)


def apply_grade_caps(
    score: int,
    day: date,
    temp_max: float | int | None,
    precip: float | int | None,
    weather_code: int | float | None,
    wind_for_grade: float | None,
    window_stays_dry: bool = False,
) -> tuple[int, int, list[str]]:
    grade_caps = []

    if temp_max is not None and float(temp_max) < 70:
        score = cap_score(score, top_score_for_grade("B"))
        grade_caps.append("temperature_high_below_70")

    rainy_day = (precip is not None and float(precip) >= 55) or is_rainy_weather_code(weather_code)
    warms_up = temp_max is not None and float(temp_max) >= 70
    cold_rainy_day = rainy_day and temp_max is not None and float(temp_max) < 65
    if cold_rainy_day:
        score = cap_score(score, top_score_for_grade("C"))
        grade_caps.append("rainy_cold_day_best_case_c")
    elif rainy_day and not (window_stays_dry and warms_up):
        score = cap_score(score, top_score_for_grade("B"))
        grade_caps.append("rainy_day_best_case_b")

    score_before_wind_cap = score
    grade_cap_for_wind = wind_grade_cap(wind_for_grade)
    if grade_cap_for_wind != "A":
        score = cap_score(score, top_score_for_grade(grade_cap_for_wind))
        grade_caps.append(f"wind_best_case_{grade_cap_for_wind.lower()}")

    return score, score_before_wind_cap, grade_caps


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
    nws = fetch_nws_forecast(spot)
    hourly_periods = nws["hourly"].get("properties", {}).get("periods", [])
    hourly = {
        "time": [],
        "wind_speed_10m": [],
        "wind_direction_10m": [],
        "wind_gusts_10m": [],
        "temperature_2m": [],
        "precipitation_probability": [],
        "short_forecast": [],
        "weather_code": [],
    }
    grouped: dict[str, list[dict]] = {}

    for period in hourly_periods:
        timestamp = period.get("startTime")
        if not timestamp:
            continue
        wind = parse_wind_mph(period.get("windSpeed")) or 0
        direction = wind_direction_degrees(period.get("windDirection"))
        precip = precip_value(period)
        hourly["time"].append(timestamp)
        hourly["wind_speed_10m"].append(wind)
        hourly["wind_direction_10m"].append(direction)
        hourly["wind_gusts_10m"].append(wind)
        hourly["temperature_2m"].append(period.get("temperature"))
        hourly["precipitation_probability"].append(precip)
        hourly["short_forecast"].append(period.get("shortForecast"))
        hourly["weather_code"].append(nws_weather_code(period.get("shortForecast", ""), precip))
        grouped.setdefault(timestamp[:10], []).append(period)

    days = []

    for day_str, periods in list(grouped.items())[:10]:
        day = date.fromisoformat(day_str)
        winds = [parse_wind_mph(period.get("windSpeed")) for period in periods]
        winds = [wind for wind in winds if wind is not None]
        temps = [period.get("temperature") for period in periods if period.get("temperature") is not None]
        precip_values = [precip_value(period) for period in periods]
        wind = max(winds) if winds else None
        gust = wind
        dominant = max((period.get("windDirection") for period in periods), key=lambda value: sum(1 for item in periods if item.get("windDirection") == value))
        direction = wind_direction_degrees(dominant)
        precip = max(precip_values) if precip_values else None
        temp_max = max(temps) if temps else None
        temp_min = min(temps) if temps else None
        most_relevant_period = max(periods, key=lambda period: precip_value(period))
        if precip is not None and precip < 35:
            most_relevant_period = max(periods, key=lambda period: period.get("temperature") or -999)
        weather_code = nws_weather_code(most_relevant_period.get("shortForecast", ""), precip or 0)
        chop = chop_proxy_ft(wind, gust)
        window = best_boating_window_for_day(hourly, day_str, temp_max)

        if window["score"] is not None:
            score = window["score"]
            score_before_wind_cap = window["score_before_wind_cap"]
            grade_caps = window["grade_caps"]
        else:
            score = 92
            if wind is not None:
                score -= max(0, int(round((float(wind) - 8) * 4.0)))
            if gust is not None:
                score -= max(0, int(round((float(gust) - 14) * 1.5)))
            if precip is not None:
                score -= max(0, int(round((float(precip) - 45) * 0.2)))
            score -= crowding_penalty(day)
            score = max(0, min(100, score))
            window_stays_dry = window["max_precip_probability"] is not None and float(window["max_precip_probability"]) <= 25
            score, score_before_wind_cap, grade_caps = apply_grade_caps(
                score,
                day,
                temp_max,
                precip,
                weather_code,
                wind,
                window_stays_dry,
            )
        days.append(
            {
                "date": day_str,
                "grade": grade_from_score(score),
                "score": score,
                "score_before_wind_cap": score_before_wind_cap,
                "grade_before_wind_cap": grade_from_score(score_before_wind_cap),
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
                "best_window_precipitation_probability_max": window["max_precip_probability"],
                "grade_caps": grade_caps,
                "crowding_penalty": crowding_penalty(day),
                "summary": "Window-based placeholder rating from live wind + crowding until Lake Pro model is approved.",
            }
        )

    daily_source = None
    if len(days) < 10:
        daily_source = fetch_open_meteo_daily(spot)
        existing_dates = {day["date"] for day in days}
        daily = daily_source.get("daily", {})
        open_hourly = daily_source.get("hourly", {})
        daily_rows = zip(
            daily.get("time", []),
            daily.get("weather_code", []),
            daily.get("temperature_2m_max", []),
            daily.get("temperature_2m_min", []),
            daily.get("precipitation_probability_max", []),
            daily.get("wind_speed_10m_max", []),
            daily.get("wind_direction_10m_dominant", []),
        )
        for day_str, weather_code, temp_max, temp_min, precip, wind, direction in daily_rows:
            if day_str in existing_dates:
                continue
            day = date.fromisoformat(day_str)
            wind = round(float(wind), 1) if wind is not None else None
            direction = int(round(float(direction))) if direction is not None else None
            precip = round(float(precip), 1) if precip is not None else None
            temp_max = round(float(temp_max)) if temp_max is not None else None
            temp_min = round(float(temp_min)) if temp_min is not None else None
            chop = chop_proxy_ft(wind, wind)
            window = best_boating_window_for_day(open_hourly, day_str, temp_max)

            if window["score"] is not None:
                score = window["score"]
                score_before_wind_cap = window["score_before_wind_cap"]
                grade_caps = window["grade_caps"]
            else:
                score = 92
                if wind is not None:
                    score -= max(0, int(round((float(wind) - 8) * 4.0)))
                if precip is not None:
                    score -= max(0, int(round((float(precip) - 45) * 0.2)))
                score -= crowding_penalty(day)
                score = max(0, min(100, score))
                score, score_before_wind_cap, grade_caps = apply_grade_caps(score, day, temp_max, precip, weather_code, wind)

            days.append(
                {
                    "date": day_str,
                    "grade": grade_from_score(score),
                    "score": score,
                    "score_before_wind_cap": score_before_wind_cap,
                    "grade_before_wind_cap": grade_from_score(score_before_wind_cap),
                    "wind_speed_max_mph": wind,
                    "wind_gust_max_mph": wind,
                    "wind_direction_deg": direction,
                    "wind_direction_label": wind_direction_label(direction),
                    "precipitation_probability_max": precip,
                    "weather_code": weather_code,
                    "temperature_2m_max": temp_max,
                    "temperature_2m_min": temp_min,
                    "chop_proxy_ft": chop,
                    "best_window": window["label"] if window["score"] is not None else "Daily outlook",
                    "best_window_wind_mph": window["avg_wind_mph"] if window["score"] is not None else wind,
                    "best_window_gust_mph": window["avg_gust_mph"] if window["score"] is not None else wind,
                    "best_window_precipitation_probability_max": window["max_precip_probability"] if window["score"] is not None else precip,
                    "grade_caps": grade_caps,
                    "crowding_penalty": crowding_penalty(day),
                    "summary": "Daily forecast fill from Open-Meteo after the live NWS hourly range ends.",
                }
            )
            existing_dates.add(day_str)
            if len(days) >= 10:
                break

    days.sort(key=lambda item: item["date"])
    days = days[:10]

    latest = days[0] if days else {}
    return {
        "spot": spot.__dict__,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": {
            "weather": "National Weather Service API",
            "url": nws["forecast_url"],
            "hourly_url": nws["hourly_url"],
            "points_url": nws["points_url"],
            "daily_fill_url": daily_source.get("url") if daily_source else None,
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
    frame_count = 24 * 7
    times = hourly.get("time", [])[:frame_count]
    speeds = hourly.get("wind_speed_10m", [])[:frame_count]
    directions = hourly.get("wind_direction_10m", [])[:frame_count]
    return {
        "spot_slug": spot.slug,
        "generated_at": forecast.get("generated_at"),
        "status": "live_weather_stub_grid",
        "frame_hours": 1,
        "forecast_days": 7,
        "note": "7-day hourly regional wind-frame scaffold uses live National Weather Service point forecast. Spatial cropped grid still pending.",
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
        output_path = MAP_LAYERS_DIR / f"payette_{name}.geojson"
        try:
            payload = fetch_json(url)
            if name == "bathymetry_contours":
                payload = slim_geojson(payload, {"Contour"})
            else:
                payload = slim_geojson(payload, {"Label", "Notes"})
            write_json(output_path, payload)
            results[name] = {"status": "ok", "features": len(payload.get("features", [])), "url": url}
        except Exception as exc:
            if output_path.exists():
                cached = json.loads(output_path.read_text())
                results[name] = {
                    "status": "cached",
                    "features": len(cached.get("features", [])),
                    "error": str(exc),
                    "url": url,
                }
            else:
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
