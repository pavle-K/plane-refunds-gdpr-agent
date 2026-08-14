/**
 * Great-circle distance between two points, per EC261's distance-banding
 * requirement. Pure geometry only — no IATA codes, no lookup table, no I/O.
 * Resolving an IATA code to coordinates is src/providers/airport-reference/'s
 * job (a provider, not domain — see its doc comment for why); this function
 * only ever sees the coordinates it's handed.
 */

export interface Coordinates {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function haversineKm(a: Coordinates, b: Coordinates): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export function getDistanceKm(origin: Coordinates, destination: Coordinates): number {
  if (origin.lat === destination.lat && origin.lon === destination.lon) {
    return 0;
  }
  return haversineKm(origin, destination);
}
