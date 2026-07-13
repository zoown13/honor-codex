import type { Benefit, SearchRequest, SearchResult } from "./types.ts";

const EARTH_RADIUS_KM = 6371.0088;

export interface Coordinate {
  latitude: number;
  longitude: number;
}

export function isValidCoordinate(point: Coordinate): boolean {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude)
    && point.latitude >= -90 && point.latitude <= 90
    && point.longitude >= -180 && point.longitude <= 180;
}

export function isCoordinateInKorea(point: Coordinate): boolean {
  return isValidCoordinate(point)
    && point.latitude >= 32.5 && point.latitude <= 39.5
    && point.longitude >= 124 && point.longitude <= 132;
}

export function haversineKm(from: Coordinate, to: Coordinate): number {
  if (!isValidCoordinate(from) || !isValidCoordinate(to)) throw new RangeError("Invalid coordinate");
  const rad = Math.PI / 180;
  const dLat = (to.latitude - from.latitude) * rad;
  const dLon = (to.longitude - from.longitude) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(from.latitude * rad) * Math.cos(to.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function searchBenefits(items: readonly Benefit[], request: SearchRequest): SearchResult[] {
  const tokens = normalizeSearch(request.query ?? "").split(" ").filter(Boolean);
  const origin = request.origin && isValidCoordinate(request.origin) ? request.origin : undefined;
  const results = items.filter((item) => {
    if (request.types?.length && !request.types.includes(item.type)) return false;
    if (request.categories?.length && !request.categories.includes(item.category)) return false;
    if (request.benefitKinds?.length && !request.benefitKinds.includes(item.benefitKind)) return false;
    if (request.regionCodes?.length && !request.regionCodes.some((code) => item.regionCodes.includes(code))) return false;
    const haystack = normalizeSearch(item.searchText || `${item.title} ${item.summary}`);
    return tokens.every((token) => haystack.includes(token));
  }).map((item): SearchResult => {
    if (!origin || !item.location) return { ...item };
    return { ...item, distanceKm: haversineKm(origin, item.location) };
  });

  return results.sort((a, b) => {
    if (origin) {
      if (a.distanceKm === undefined && b.distanceKm !== undefined) return 1;
      if (a.distanceKm !== undefined && b.distanceKm === undefined) return -1;
      if (a.distanceKm !== undefined && b.distanceKm !== undefined && a.distanceKm !== b.distanceKm) {
        return a.distanceKm - b.distanceKm;
      }
    }
    return a.title.localeCompare(b.title, "ko-KR") || a.id.localeCompare(b.id);
  });
}

function normalizeSearch(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/\s+/g, " ").trim();
}
