const approvedCameraOverrides = {
  "lake-tahoe": {
    title: "Live Lake View",
    description: "Current South Lake Tahoe shoreline view",
    sourceUrl: "https://edgewoodtahoe.com/webcam/",
    imageUrl: "assets/edgewood-tahoe-camera.png",
    alt: "Edgewood Tahoe webcam screenshot over Lake Tahoe",
  },
  "payette-lake": {
    title: "Live Lake View",
    description: "Current Payette Lake marina view",
    sourceUrl: "https://milehighmarina.com/webcams/",
    imageUrl: "assets/mile-high-marina-camera.png",
    alt: "Mile High Marina webcam screenshot over Payette Lake",
  },
};

const capturedCameraSlugs = new Set([
  "canyon-lake",
  "flathead-lake",
  "lake-amistad",
  "lake-coeur-d-alene",
  "lake-conroe",
  "lake-geneva",
  "lake-george",
  "lake-havasu",
  "lake-powell",
  "lake-travis",
  "lake-winnipesaukee",
  "lake-winnisquam",
]);

const unusableCameraSlugs = new Set([
  "deer-creek-reservoir",
  "jordanelle-reservoir",
  "lake-lanier",
  "lake-mead",
  "lake-minnetonka",
  "lake-norman",
  "lake-of-the-ozarks",
  "lake-shasta",
  "okanagan-lake",
  "smith-mountain-lake",
  "utah-lake",
]);

export function cameraAssetUrl(spot) {
  if (!spot?.slug) return "assets/hero-image.jpg";
  return `assets/cameras/${spot.slug}.png`;
}

export function cameraForSpot(spot) {
  if (!spot) return null;
  const override = approvedCameraOverrides[spot.slug];
  if (override) return override;
  if (unusableCameraSlugs.has(spot.slug)) return null;
  if (!capturedCameraSlugs.has(spot.slug)) return null;
  if (!spot.webcam?.url) return null;
  return {
    title: "Live Lake View",
    description: spot.webcam.label || `Current ${spot.name} lake view`,
    sourceUrl: spot.webcam.url,
    imageUrl: cameraAssetUrl(spot),
    alt: `${spot.name} webcam screenshot`,
  };
}
