/**
 * Great-circle distance between airports, per EC261's distance-banding requirement.
 *
 * The coordinate table below is a starter set of major airports for development and
 * testing — it is NOT a complete IATA database. Before relying on this for real claims
 * involving airports outside this list, replace it with a complete, sourced dataset
 * (e.g. OpenFlights airports.dat) rather than hand-extending it, since a wrong
 * coordinate here silently produces a wrong distance band and a wrong € amount.
 */

export interface AirportCoordinates {
  iata: string;
  lat: number;
  lon: number;
}

const EARTH_RADIUS_KM = 6371;

const AIRPORTS: Record<string, AirportCoordinates> = {
  LHR: { iata: "LHR", lat: 51.47, lon: -0.4543 },
  JFK: { iata: "JFK", lat: 40.6413, lon: -73.7781 },
  CDG: { iata: "CDG", lat: 49.0097, lon: 2.5479 },
  DXB: { iata: "DXB", lat: 25.2532, lon: 55.3657 },
  FRA: { iata: "FRA", lat: 50.0379, lon: 8.5622 },
  SIN: { iata: "SIN", lat: 1.3644, lon: 103.9915 },
  LAX: { iata: "LAX", lat: 33.9416, lon: -118.4085 },
  SYD: { iata: "SYD", lat: -33.9399, lon: 151.1753 },
  AMS: { iata: "AMS", lat: 52.3105, lon: 4.7683 },
  MAD: { iata: "MAD", lat: 40.4983, lon: -3.5676 },
  FCO: { iata: "FCO", lat: 41.8003, lon: 12.2389 },
  DUB: { iata: "DUB", lat: 53.4213, lon: -6.2701 },
  ATH: { iata: "ATH", lat: 37.9364, lon: 23.9445 },
  WAW: { iata: "WAW", lat: 52.1657, lon: 20.9671 },
  ARN: { iata: "ARN", lat: 59.6519, lon: 17.9186 },
  ORD: { iata: "ORD", lat: 41.9742, lon: -87.9073 },
  ATL: { iata: "ATL", lat: 33.6407, lon: -84.4277 },
  HND: { iata: "HND", lat: 35.5494, lon: 139.7798 },
  PEK: { iata: "PEK", lat: 40.0799, lon: 116.6031 },
  GRU: { iata: "GRU", lat: -23.4356, lon: -46.4731 },
  JNB: { iata: "JNB", lat: -26.1392, lon: 28.246 },
  YYZ: { iata: "YYZ", lat: 43.6777, lon: -79.6248 },
  DOH: { iata: "DOH", lat: 25.2731, lon: 51.6081 },
  IST: { iata: "IST", lat: 41.2753, lon: 28.7519 },
  BCN: { iata: "BCN", lat: 41.2971, lon: 2.0785 },
  LIS: { iata: "LIS", lat: 38.7813, lon: -9.1359 },
  VIE: { iata: "VIE", lat: 48.1103, lon: 16.5697 },
  ZRH: { iata: "ZRH", lat: 47.4647, lon: 8.5492 },
  BRU: { iata: "BRU", lat: 50.9014, lon: 4.4844 },
  CPH: { iata: "CPH", lat: 55.618, lon: 12.656 },
  HEL: { iata: "HEL", lat: 60.3172, lon: 24.9633 },
  PRG: { iata: "PRG", lat: 50.1008, lon: 14.26 },
  CGK: { iata: "CGK", lat: -6.1256, lon: 106.6558 },
  VCE: { iata: "VCE", lat: 45.5053, lon: 12.3519 },
};

export class UnknownAirportError extends Error {
  constructor(iata: string) {
    super(`Unknown IATA airport code: ${iata}`);
    this.name = "UnknownAirportError";
  }
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function lookupAirport(iata: string): AirportCoordinates {
  const code = iata.toUpperCase();
  const airport = AIRPORTS[code];
  if (!airport) {
    throw new UnknownAirportError(code);
  }
  return airport;
}

function haversineKm(a: AirportCoordinates, b: AirportCoordinates): number {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export function getDistanceKm(originIata: string, destinationIata: string): number {
  const origin = lookupAirport(originIata);
  const destination = lookupAirport(destinationIata);

  if (origin.iata === destination.iata) {
    return 0;
  }

  return haversineKm(origin, destination);
}
