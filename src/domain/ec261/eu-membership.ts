/**
 * Which ISO-3166-1 alpha-2 country codes count as "EU" for EC261 route-coverage
 * purposes (Art. 3(1)) — the 27 current EU member states. Unlike distance.ts's
 * former airport table, this is deliberately a COMPLETE, authoritative list, not
 * a starter set: EU membership changes rarely and publicly (most recently
 * Croatia's 2013 accession and the UK's 2020 exit), so hardcoding it here is the
 * right call, not a shortcut — there's no larger "real" dataset this is a stand-in
 * for. If a country ever joins/leaves the EU, this is the one place to update.
 *
 * Deliberately does NOT live in src/providers/airport-reference/ or the airports
 * DB table: EU membership is a legal fact about a COUNTRY, not a geographic fact
 * about an AIRPORT, and keeping it out of the imported/looked-up airport dataset
 * means a bad geodata row can misplace an airport at worst — it can never
 * silently misjudge which countries the law covers.
 */
const EU_MEMBER_COUNTRY_CODES = new Set([
  "AT", // Austria
  "BE", // Belgium
  "BG", // Bulgaria
  "HR", // Croatia
  "CY", // Cyprus
  "CZ", // Czechia
  "DK", // Denmark
  "EE", // Estonia
  "FI", // Finland
  "FR", // France
  "DE", // Germany
  "GR", // Greece
  "HU", // Hungary
  "IE", // Ireland
  "IT", // Italy
  "LV", // Latvia
  "LT", // Lithuania
  "LU", // Luxembourg
  "MT", // Malta
  "NL", // Netherlands
  "PL", // Poland
  "PT", // Portugal
  "RO", // Romania
  "SK", // Slovakia
  "SI", // Slovenia
  "ES", // Spain
  "SE", // Sweden
]);

export function isEuMemberCountry(countryIsoCode: string): boolean {
  return EU_MEMBER_COUNTRY_CODES.has(countryIsoCode.toUpperCase());
}
