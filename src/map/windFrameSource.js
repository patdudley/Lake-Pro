export const windFrameSources = {
  "lake-tahoe": {
    status: "stub",
    pipeline: "cropped-regional-wind-frame",
    frameUrl: null,
    bounds: [-120.22, 38.86, -119.90, 39.28],
    generatedAt: null,
    note: "Placeholder Tahoe regional wind frame. No real wind data generated.",
  },
  "payette-lake": {
    status: "stub",
    pipeline: "cropped-regional-wind-frame",
    frameUrl: null,
    bounds: [-116.16, 44.87, -116.03, 45.01],
    generatedAt: null,
    note: "Placeholder Payette Lake regional wind frame. No real wind data generated.",
  },
};

export function windFrameForSpot(spot) {
  return windFrameSources[spot.slug] || null;
}
