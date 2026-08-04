/**
 * Limitation periods and response timeouts. All functions take an explicit `now`
 * (or anchor date) parameter — never read the ambient wall clock inside domain code,
 * so results stay deterministic and testable across timezones/DST.
 *
 * The limitation-period table is a starting point, not settled legal fact: EC261
 * itself sets no deadline, so national civil-law limitation periods apply, and
 * several member states' courts disagree on which national rule governs an EC261
 * claim (Italy and the Netherlands in particular have unsettled case law on this).
 * Verify with counsel before relying on a jurisdiction's period for a real claim.
 */

const LIMITATION_PERIOD_YEARS: Record<string, number> = {
  DE: 3, // Germany — BGB §195 general limitation period
  FR: 5, // France
  ES: 5, // Spain
  IT: 2, // Italy — Codice della navigazione, carrier liability (disputed in some courts)
  NL: 2, // Netherlands — by analogy to Montreal Convention (disputed in some courts)
  IE: 6, // Ireland
  AT: 3, // Austria
};

export interface LimitationPeriodInput {
  /** ISO 3166-1 alpha-2 country code of the governing jurisdiction. */
  countryCode: string;
  /** Anchor date for the limitation period — typically the flight/disruption date. */
  flightDateUtc: Date;
}

export class UnknownJurisdictionError extends Error {
  constructor(countryCode: string) {
    super(`No limitation period configured for jurisdiction: ${countryCode}`);
    this.name = "UnknownJurisdictionError";
  }
}

export function getLimitationDeadlineUtc(input: LimitationPeriodInput): Date {
  const years = LIMITATION_PERIOD_YEARS[input.countryCode.toUpperCase()];
  if (years === undefined) {
    throw new UnknownJurisdictionError(input.countryCode);
  }

  const deadline = new Date(input.flightDateUtc.getTime());
  deadline.setUTCFullYear(deadline.getUTCFullYear() + years);
  return deadline;
}

export function isPastLimitationDeadline(input: LimitationPeriodInput, now: Date): boolean {
  return now.getTime() > getLimitationDeadlineUtc(input).getTime();
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function getAirlineResponseDeadlineUtc(sentAtUtc: Date, timeoutDays: number): Date {
  return new Date(sentAtUtc.getTime() + timeoutDays * MS_PER_DAY);
}

export function hasAirlineTimedOut(sentAtUtc: Date, timeoutDays: number, now: Date): boolean {
  return now.getTime() >= getAirlineResponseDeadlineUtc(sentAtUtc, timeoutDays).getTime();
}
