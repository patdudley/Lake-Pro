#!/usr/bin/env python3
"""Refresh Lake Pro shoreline masks from OpenStreetMap/Overpass.

The browser can fetch OSM as a fallback, but production should ship lake masks
so every report page has a deterministic water polygon for the conditions layer.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "src" / "spots" / "lakeCatalog.js"
OUTPUT_DIR = ROOT / "data" / "live" / "map_layers"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "LakePro shoreline mask refresh"


def load_catalog() -> list[dict]:
    text = CATALOG_PATH.read_text()
    start = text.index("[")
    end = text.rindex("];") + 1
    payload = re.sub(r",(\s*[\]}])", r"\1", text[start:end])
    return json.loads(payload)


def post_overpass(query: str, timeout: int = 60) -> dict:
    data = urllib.parse.urlencode({"data": query}).encode()
    request = urllib.request.Request(
        OVERPASS_URL,
        data=data,
        headers={
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def get_json(url: str, timeout: int = 30) -> dict | list:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def radius_for_spot(spot: dict) -> int:
    name = f"{spot.get('name', '')} {spot.get('slug', '')}".lower()
    large_terms = (
        "powell",
        "mead",
        "amistad",
        "texoma",
        "ozarks",
        "lanier",
        "cumberland",
        "shasta",
        "koocanusa",
        "pend-oreille",
        "flaming-gorge",
        "flathead",
        "norman",
        "hartwell",
        "allatoona",
        "sam-rayburn",
        "mohave",
        "washington",
        "wanaka",
        "simcoe",
        "murray",
    )
    if any(term in name for term in large_terms):
        return 70000
    if spot.get("tier") == "international":
        return 52000
    return 32000


def spot_terms(spot: dict) -> list[str]:
    raw = f"{spot.get('name', '')} {spot.get('location', '')} {spot.get('slug', '')}".lower()
    terms = [term for term in raw.replace("/", " ").replace("-", " ").split() if len(term) > 2]
    stop = {"lake", "reservoir", "area", "chain", "the", "and", "bay"}
    return [term for term in terms if term not in stop]


def choose_relation(osm: dict, spot: dict) -> dict | None:
    terms = spot_terms(spot)
    best = None
    for element in osm.get("elements", []):
        if element.get("type") != "relation":
            continue
        tags = element.get("tags", {})
        name = str(tags.get("name", "")).lower()
        alt_names = " ".join(str(tags.get(key, "")).lower() for key in ("alt_name", "short_name", "official_name"))
        haystack = f"{name} {alt_names}"
        name_score = sum(1 for term in terms if term in haystack)
        center = element.get("center", {})
        center_distance = coordinate_distance(
            center.get("lon"),
            center.get("lat"),
            spot.get("longitude"),
            spot.get("latitude"),
        )
        water_score = 1 if tags.get("natural") == "water" or tags.get("water") in {"lake", "reservoir"} else 0
        score = (name_score * 1000) + (water_score * 50) - center_distance
        candidate = (score, element)
        if best is None or candidate[0] > best[0]:
            best = candidate
    return best[1] if best else None


def coordinate_distance(lon_a, lat_a, lon_b, lat_b) -> float:
    if not all(isinstance(value, (int, float)) for value in (lon_a, lat_a, lon_b, lat_b)):
        return 999
    return math.hypot(float(lon_a) - float(lon_b), float(lat_a) - float(lat_b))


def coordinate_key(coordinate: list[float]) -> str:
    return f"{coordinate[0]:.6f},{coordinate[1]:.6f}"


def is_closed(ring: list[list[float]]) -> bool:
    return len(ring) >= 4 and coordinate_key(ring[0]) == coordinate_key(ring[-1])


def ring_area(ring: list[list[float]]) -> float:
    area = 0.0
    previous = len(ring) - 1
    for index, coordinate in enumerate(ring):
        area += ring[previous][0] * coordinate[1] - coordinate[0] * ring[previous][1]
        previous = index
    return area / 2


def assemble_rings(segments: list[list[list[float]]]) -> list[list[list[float]]]:
    remaining = [segment for segment in segments if len(segment) > 1]
    rings: list[list[list[float]]] = []
    while remaining:
        ring = remaining.pop(0)
        changed = True
        while not is_closed(ring) and changed:
            changed = False
            start = coordinate_key(ring[0])
            end = coordinate_key(ring[-1])
            match_index = -1
            for index, segment in enumerate(remaining):
                segment_start = coordinate_key(segment[0])
                segment_end = coordinate_key(segment[-1])
                if segment_start in {start, end} or segment_end in {start, end}:
                    match_index = index
                    break
            if match_index < 0:
                continue
            segment = remaining.pop(match_index)
            segment_start = coordinate_key(segment[0])
            segment_end = coordinate_key(segment[-1])
            if segment_start == end:
                ring += segment[1:]
            elif segment_end == end:
                ring += list(reversed(segment))[1:]
            elif segment_end == start:
                ring = segment + ring[1:]
            elif segment_start == start:
                ring = list(reversed(segment)) + ring[1:]
            changed = True
        if is_closed(ring):
            rings.append(ring)
    return sorted(rings, key=lambda item: abs(ring_area(item)), reverse=True)


def relation_to_geojson(osm: dict, relation_id: int, spot: dict) -> dict | None:
    relation = next(
        (element for element in osm.get("elements", []) if element.get("type") == "relation" and element.get("id") == relation_id),
        None,
    )
    if not relation:
        return None
    ways = {
        element.get("id"): [[point["lon"], point["lat"]] for point in element.get("geometry", [])]
        for element in osm.get("elements", [])
        if element.get("type") == "way" and len(element.get("geometry", [])) > 1
    }
    outer_segments = [
        ways.get(member.get("ref"))
        for member in relation.get("members", [])
        if member.get("type") == "way" and member.get("role") != "inner"
    ]
    rings = assemble_rings([segment for segment in outer_segments if segment])
    if not rings:
        return None
    return feature_collection(spot, rings, "OpenStreetMap water multipolygon", relation_id)


def way_candidates_to_geojson(osm: dict, spot: dict) -> dict | None:
    terms = set(spot_terms(spot) + ["lake", "reservoir"])
    candidates = []
    for element in osm.get("elements", []):
        if element.get("type") != "way" or len(element.get("geometry", [])) < 4:
            continue
        tags = element.get("tags", {})
        if not (tags.get("natural") == "water" or tags.get("water") in {"lake", "reservoir"}):
            continue
        ring = [[point["lon"], point["lat"]] for point in element.get("geometry", [])]
        if not is_closed(ring):
            continue
        name = str(tags.get("name", "")).lower()
        name_score = sum(1 for term in terms if term in name)
        area = abs(ring_area(ring))
        center = ring_center(ring)
        distance = coordinate_distance(center[0], center[1], spot.get("longitude"), spot.get("latitude"))
        if area <= 0.000002:
            continue
        near_point = 1 if point_in_ring(spot["longitude"], spot["latitude"], ring) or distance <= 0.12 else 0
        candidates.append((near_point, area, name_score, -distance, ring, element.get("id")))
    candidates.sort(reverse=True)
    rings = [candidate[4] for candidate in candidates[:24]]
    if not rings:
        return None
    return feature_collection(spot, rings, "OpenStreetMap water ways", candidates[0][5])


def point_in_ring(lng: float, lat: float, ring: list[list[float]]) -> bool:
    inside = False
    previous = len(ring) - 1
    for index, point in enumerate(ring):
        x1, y1 = point[0], point[1]
        x2, y2 = ring[previous][0], ring[previous][1]
        if ((y1 > lat) != (y2 > lat)) and (
            lng < (x2 - x1) * (lat - y1) / ((y2 - y1) or 1e-15) + x1
        ):
            inside = not inside
        previous = index
    return inside


def ring_center(ring: list[list[float]]) -> tuple[float, float]:
    lngs = [point[0] for point in ring]
    lats = [point[1] for point in ring]
    return (sum(lngs) / len(lngs), sum(lats) / len(lats))


def feature_collection(spot: dict, rings: list[list[list[float]]], source: str, osm_id: int | None) -> dict:
    geometry = {
        "type": "Polygon" if len(rings) == 1 else "MultiPolygon",
        "coordinates": [rings[0]] if len(rings) == 1 else [[ring] for ring in rings],
    }
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "source": source,
                    "osm_id": osm_id,
                    "name": spot["name"],
                },
                "geometry": geometry,
            }
        ],
    }


def fetch_shoreline(spot: dict, force_overpass: bool = False) -> dict | None:
    if not force_overpass:
        nominatim = fetch_nominatim_shoreline(spot)
        if nominatim:
            return nominatim

    radius = radius_for_spot(spot)
    lat = spot["latitude"]
    lng = spot["longitude"]
    relation_query = f"""
      [out:json][timeout:35];
      (
        relation(around:{radius},{lat},{lng})["type"="multipolygon"]["natural"="water"];
        relation(around:{radius},{lat},{lng})["type"="multipolygon"]["water"~"^(lake|reservoir)$"];
      );
      out tags center;
    """
    relation_list = post_overpass(relation_query, timeout=55)
    relation = choose_relation(relation_list, spot)
    if relation:
        geometry_query = f"""
          [out:json][timeout:55];
          relation({relation["id"]});
          out body;
          way(r);
          out geom;
        """
        geometry = post_overpass(geometry_query, timeout=75)
        shoreline = relation_to_geojson(geometry, relation["id"], spot)
        if shoreline:
            return shoreline

    way_query = f"""
      [out:json][timeout:35];
      (
        way(around:{radius},{lat},{lng})["natural"="water"];
        way(around:{radius},{lat},{lng})["water"="reservoir"];
        way(around:{radius},{lat},{lng})["water"="lake"];
      );
      out tags geom;
    """
    ways = post_overpass(way_query, timeout=55)
    return way_candidates_to_geojson(ways, spot)


def fetch_nominatim_shoreline(spot: dict) -> dict | None:
    queries = [
        f"{spot['name']} {spot.get('location', '')}",
        f"{spot['name']} {spot.get('country', '')}",
        spot["name"],
    ]
    seen = set()
    candidates = []
    for query in queries:
        normalized = " ".join(str(query).split())
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        url = f"{NOMINATIM_URL}?{urllib.parse.urlencode({'q': normalized, 'format': 'jsonv2', 'polygon_geojson': 1, 'limit': 5})}"
        results = get_json(url, timeout=25)
        for result in results if isinstance(results, list) else []:
            geometry = result.get("geojson")
            if not geometry or geometry.get("type") not in {"Polygon", "MultiPolygon"}:
                continue
            bounds = geometry_bounds(geometry)
            if bounds and distance_to_bounds(spot["longitude"], spot["latitude"], bounds) > 0.04:
                continue
            category = str(result.get("category", "")).lower()
            result_type = str(result.get("type", "")).lower()
            display = str(result.get("display_name", "")).lower()
            water_score = 1 if category in {"water", "natural"} or result_type in {"lake", "reservoir", "water"} else 0
            name_score = sum(1 for term in spot_terms(spot) if term in display)
            importance = float(result.get("importance") or 0)
            distance = coordinate_distance(
                float(result.get("lon", spot["longitude"])),
                float(result.get("lat", spot["latitude"])),
                spot["longitude"],
                spot["latitude"],
            )
            score = water_score * 1000 + name_score * 100 + importance * 10 - distance
            candidates.append((score, result, geometry))
        if candidates:
            break
        time.sleep(1.0)

    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0], reverse=True)
    _, result, geometry = candidates[0]
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "source": "OpenStreetMap Nominatim",
                    "osm_id": result.get("osm_id"),
                    "osm_type": result.get("osm_type"),
                    "name": spot["name"],
                    "display_name": result.get("display_name"),
                },
                "geometry": geometry,
            }
        ],
    }


def geometry_bounds(geometry: dict) -> tuple[float, float, float, float] | None:
    coordinates = []
    if geometry.get("type") == "Polygon":
        coordinates = [point for ring in geometry.get("coordinates", []) for point in ring]
    elif geometry.get("type") == "MultiPolygon":
        coordinates = [point for polygon in geometry.get("coordinates", []) for ring in polygon for point in ring]
    if not coordinates:
        return None
    return (
        min(point[0] for point in coordinates),
        min(point[1] for point in coordinates),
        max(point[0] for point in coordinates),
        max(point[1] for point in coordinates),
    )


def distance_to_bounds(lng: float, lat: float, bounds: tuple[float, float, float, float]) -> float:
    west, south, east, north = bounds
    dx = max(west - lng, 0, lng - east)
    dy = max(south - lat, 0, lat - north)
    return math.hypot(dx, dy)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only-missing", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--slug", action="append", default=[])
    parser.add_argument("--force-overpass", action="store_true")
    parser.add_argument("--sleep", type=float, default=1.2)
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    spots = load_catalog()
    if args.slug:
        allowed = set(args.slug)
        spots = [spot for spot in spots if spot["slug"] in allowed]
    if args.only_missing:
        spots = [spot for spot in spots if not (OUTPUT_DIR / f"{spot['slug']}_shoreline.geojson").exists()]
    if args.limit:
        spots = spots[: args.limit]

    failures = []
    for index, spot in enumerate(spots, 1):
        output_path = OUTPUT_DIR / f"{spot['slug']}_shoreline.geojson"
        print(f"[{index}/{len(spots)}] {spot['slug']} ...", flush=True)
        try:
            shoreline = fetch_shoreline(spot, force_overpass=args.force_overpass)
            if not shoreline or not shoreline.get("features"):
                raise RuntimeError("no shoreline features returned")
            output_path.write_text(json.dumps(shoreline, separators=(",", ":")))
            print(f"  wrote {output_path.relative_to(ROOT)}", flush=True)
        except Exception as exc:  # noqa: BLE001
            failures.append({"slug": spot["slug"], "name": spot["name"], "error": str(exc)})
            print(f"  failed: {exc}", flush=True)
        if index < len(spots) and args.sleep:
            time.sleep(args.sleep)

    report_path = ROOT / "reports" / "shoreline-mask-audit.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps({"failures": failures}, indent=2))
    print(f"Failures: {len(failures)}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
