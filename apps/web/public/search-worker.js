const EARTH_RADIUS_KM = 6371.0088;

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function distanceKm(first, second) {
  const latitudeDelta = toRadians(second.latitude - first.latitude);
  const longitudeDelta = toRadians(second.longitude - first.longitude);
  const firstLatitude = toRadians(first.latitude);
  const secondLatitude = toRadians(second.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(haversine));
}

self.onmessage = (event) => {
  const started = performance.now();
  const { requestId, items, request } = event.data;
  const terms = (request.query || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const results = items
    .filter((item) => {
      if (item.status === "ENDED") return false;
      if (request.types?.length && !request.types.includes(item.type)) return false;
      if (request.categories?.length && !request.categories.includes(item.category)) return false;
      if (request.benefitKinds?.length && !request.benefitKinds.includes(item.benefitKind)) {
        return false;
      }
      if (
        request.regionCodes?.length &&
        !request.regionCodes.some((code) => item.regionCodes.includes(code))
      ) {
        return false;
      }
      if (terms.length) {
        const searchable = `${item.title} ${item.provider} ${item.summary} ${item.searchText}`
          .normalize("NFKC")
          .toLocaleLowerCase("ko-KR");
        if (!terms.every((term) => searchable.includes(term))) return false;
      }
      return true;
    })
    .map((item) => {
      if (!request.origin || !item.location) return { ...item };
      return { ...item, distanceKm: distanceKm(request.origin, item.location) };
    })
    .sort((first, second) => {
      if (request.origin) {
        const distance =
          (first.distanceKm ?? Number.POSITIVE_INFINITY) -
          (second.distanceKm ?? Number.POSITIVE_INFINITY);
        if (distance) return distance;
      }
      return Date.parse(second.updatedAt) - Date.parse(first.updatedAt) ||
        first.title.localeCompare(second.title, "ko-KR");
    });

  self.postMessage({ requestId, results, elapsedMs: performance.now() - started });
};
