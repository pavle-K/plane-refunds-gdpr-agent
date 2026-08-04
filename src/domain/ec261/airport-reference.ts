/**
 * ICAO station code + EU-country facts for the same starter set of airports as
 * distance.ts (kept as a separate table rather than merging into distance.ts, to
 * avoid touching that already-tested Stage 1 file). Same caveat applies: this is a
 * starter set for development, not a complete/sourced dataset — extend both
 * together before relying on airports outside this list.
 */
export interface AirportReference {
  icao: string;
  /** True if this airport is in an EU member state (not the wider EEA/UK). */
  countryIsEu: boolean;
}

const AIRPORT_REFERENCE: Record<string, AirportReference> = {
  LHR: { icao: "EGLL", countryIsEu: false }, // UK, post-Brexit
  JFK: { icao: "KJFK", countryIsEu: false },
  CDG: { icao: "LFPG", countryIsEu: true },
  DXB: { icao: "OMDB", countryIsEu: false },
  FRA: { icao: "EDDF", countryIsEu: true },
  SIN: { icao: "WSSS", countryIsEu: false },
  LAX: { icao: "KLAX", countryIsEu: false },
  SYD: { icao: "YSSY", countryIsEu: false },
  AMS: { icao: "EHAM", countryIsEu: true },
  MAD: { icao: "LEMD", countryIsEu: true },
  FCO: { icao: "LIRF", countryIsEu: true },
  DUB: { icao: "EIDW", countryIsEu: true },
  ATH: { icao: "LGAV", countryIsEu: true },
  WAW: { icao: "EPWA", countryIsEu: true },
  ARN: { icao: "ESSA", countryIsEu: true },
  ORD: { icao: "KORD", countryIsEu: false },
  ATL: { icao: "KATL", countryIsEu: false },
  HND: { icao: "RJTT", countryIsEu: false },
  PEK: { icao: "ZBAA", countryIsEu: false },
  GRU: { icao: "SBGR", countryIsEu: false },
  JNB: { icao: "FAOR", countryIsEu: false },
  YYZ: { icao: "CYYZ", countryIsEu: false },
  DOH: { icao: "OTHH", countryIsEu: false },
  IST: { icao: "LTFM", countryIsEu: false },
  BCN: { icao: "LEBL", countryIsEu: true },
  LIS: { icao: "LPPT", countryIsEu: true },
  VIE: { icao: "LOWW", countryIsEu: true },
  ZRH: { icao: "LSZH", countryIsEu: false }, // Switzerland — not an EU member
  BRU: { icao: "EBBR", countryIsEu: true },
  CPH: { icao: "EKCH", countryIsEu: true },
  HEL: { icao: "EFHK", countryIsEu: true },
  PRG: { icao: "LKPR", countryIsEu: true },
};

export class UnknownAirportReferenceError extends Error {
  constructor(iata: string) {
    super(`No airport reference data for IATA code: ${iata}`);
    this.name = "UnknownAirportReferenceError";
  }
}

export function getAirportReference(iata: string): AirportReference {
  const entry = AIRPORT_REFERENCE[iata.toUpperCase()];
  if (!entry) {
    throw new UnknownAirportReferenceError(iata);
  }
  return entry;
}
