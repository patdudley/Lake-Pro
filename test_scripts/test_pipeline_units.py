# ABOUTME: Unit tests for pure functions in scripts/lakepro_pipeline.py.
# ABOUTME: Run with: python3 -m unittest discover test_scripts -v

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from lakepro_pipeline import (
    MAX_PREVIEW_RING_POINTS,
    MAX_PREVIEW_RINGS,
    daily_gust_max,
    grade_from_score,
    projected_preview_rings,
    wind_direction_degrees,
    wind_direction_label,
)


class WindDirectionTests(unittest.TestCase):
    def test_cardinal_degrees(self):
        self.assertEqual(wind_direction_degrees("N"), 0)
        self.assertEqual(wind_direction_degrees("E"), 90)
        self.assertEqual(wind_direction_degrees("S"), 180)
        self.assertEqual(wind_direction_degrees("W"), 270)

    def test_intercardinal_degrees_use_22_5_steps(self):
        self.assertEqual(wind_direction_degrees("WSW"), 248)
        self.assertEqual(wind_direction_degrees("NNW"), 338)

    def test_label_round_trip(self):
        for label in ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]:
            self.assertEqual(wind_direction_label(wind_direction_degrees(label)), label)

    def test_invalid_labels(self):
        self.assertIsNone(wind_direction_degrees(None))
        self.assertIsNone(wind_direction_degrees("variable"))


class DailyGustMaxTests(unittest.TestCase):
    def test_groups_max_gust_by_day(self):
        hourly = {
            "time": ["2026-07-03T06:00", "2026-07-03T14:00", "2026-07-04T10:00"],
            "wind_gusts_10m": [8.0, 21.5, None],
        }
        self.assertEqual(daily_gust_max(hourly), {"2026-07-03": 21.5})

    def test_empty_hourly(self):
        self.assertEqual(daily_gust_max({}), {})


class GradeFromScoreTests(unittest.TestCase):
    def test_grade_boundaries(self):
        self.assertEqual(grade_from_score(85), "A")
        self.assertEqual(grade_from_score(84), "B")
        self.assertEqual(grade_from_score(72), "B")
        self.assertEqual(grade_from_score(71), "C")
        self.assertEqual(grade_from_score(60), "C")
        self.assertEqual(grade_from_score(59), "D")
        self.assertEqual(grade_from_score(48), "D")
        self.assertEqual(grade_from_score(47), "F")


class PreviewRingTests(unittest.TestCase):
    def square_ring(self, size=0.1, offset=(0.0, 0.0), points_per_edge=1):
        lng0, lat0 = offset
        corners = [
            (lng0, lat0),
            (lng0 + size, lat0),
            (lng0 + size, lat0 + size),
            (lng0, lat0 + size),
        ]
        ring = []
        for index, (lng, lat) in enumerate(corners):
            next_lng, next_lat = corners[(index + 1) % 4]
            for step in range(points_per_edge):
                t = step / points_per_edge
                ring.append([lng + (next_lng - lng) * t, lat + (next_lat - lat) * t])
        ring.append(list(ring[0]))
        return ring

    def test_dense_ring_is_decimated(self):
        ring = self.square_ring(points_per_edge=500)
        [projected] = projected_preview_rings([ring])
        self.assertLessEqual(len(projected.split(" ")), MAX_PREVIEW_RING_POINTS)

    def test_subpixel_island_is_dropped(self):
        lake = self.square_ring(size=0.1)
        island = self.square_ring(size=0.0001, offset=(0.05, 0.05))
        projected = projected_preview_rings([lake, island])
        self.assertEqual(len(projected), 1)

    def test_ring_count_is_capped(self):
        lake = self.square_ring(size=0.5)
        islands = [
            self.square_ring(size=0.02, offset=(0.05 * (index % 9) + 0.01, 0.05 * (index // 9) + 0.01))
            for index in range(MAX_PREVIEW_RINGS + 30)
        ]
        projected = projected_preview_rings([lake] + islands)
        self.assertEqual(len(projected), MAX_PREVIEW_RINGS)

    def test_largest_ring_kept_first(self):
        lake = self.square_ring(size=0.1)
        island = self.square_ring(size=0.01, offset=(0.02, 0.02))
        projected = projected_preview_rings([island, lake])
        self.assertEqual(len(projected), 2)
        first_points = [tuple(map(float, pair.split(","))) for pair in projected[0].split(" ")]
        xs = [x for x, _ in first_points]
        self.assertGreater(max(xs) - min(xs), 30)

    def test_empty_input(self):
        self.assertEqual(projected_preview_rings([]), [])


if __name__ == "__main__":
    unittest.main()
