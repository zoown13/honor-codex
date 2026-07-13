import type { Benefit, SearchRequest, SearchResult } from "@honor/core";

const EARTH_RADIUS_KM = 6_371.0088;

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

export function distanceKm(
  first: { latitude: number; longitude: number },
  second: { latitude: number; longitude: number }
) {
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

function normalizedTerms(query: string | undefined) {
  return (query ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function searchBenefits(items: Benefit[], request: SearchRequest): SearchResult[] {
  const terms = normalizedTerms(request.query);

  const results = items
    .filter((item) => {
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

      return item.status !== "ENDED";
    })
    .map<SearchResult>((item) => {
      if (!request.origin || !item.location) return { ...item };
      return { ...item, distanceKm: distanceKm(request.origin, item.location) };
    });

  return results.sort((first, second) => {
    if (request.origin) {
      const firstDistance = first.distanceKm ?? Number.POSITIVE_INFINITY;
      const secondDistance = second.distanceKm ?? Number.POSITIVE_INFINITY;
      if (firstDistance !== secondDistance) return firstDistance - secondDistance;
    }

    const updated = Date.parse(second.updatedAt) - Date.parse(first.updatedAt);
    return updated || first.title.localeCompare(second.title, "ko-KR");
  });
}
