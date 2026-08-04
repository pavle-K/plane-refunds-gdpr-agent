/**
 * "Extraordinary circumstances" (EC261 Art. 5(3)) is the airline's defence against
 * paying compensation. Case law has narrowed this considerably — most causes an
 * airline cites are NOT valid defences, because they're considered inherent to
 * normal airline operation:
 *
 * - Technical/mechanical faults: generally NOT extraordinary (Wallentin-Hermann v
 *   Alitalia, C-549/07) — aircraft maintenance issues are part of normal operation.
 * - The airline's OWN staff striking: NOT extraordinary (TUIfly wildcat strike,
 *   C-195/17) — staff relations are within the airline's sphere of control, even
 *   for a spontaneous/unofficial strike.
 * - Third-party strikes (ATC, airport ground handling not employed by the airline):
 *   valid defences, since these are genuinely outside the airline's control.
 * - Weather at/below operating minima, security threats: valid defences.
 *
 * An unknown or absent cause code must never default to "the airline is right" —
 * that would silently hand the airline its defence. It returns "unproven" instead,
 * pushing the decision to a human/evidence review rather than the domain layer.
 */

export type ExtraordinaryCauseCode =
  | "weather_below_minima"
  | "atc_strike"
  | "third_party_staff_strike"
  | "airline_staff_strike"
  | "technical_fault"
  | "security_threat"
  | "unknown";

export type ExtraordinaryVerdict = "valid_defence" | "not_valid_defence" | "unproven";

const VALID_DEFENCE_CODES: ReadonlySet<ExtraordinaryCauseCode> = new Set([
  "weather_below_minima",
  "atc_strike",
  "third_party_staff_strike",
  "security_threat",
]);

const NOT_VALID_DEFENCE_CODES: ReadonlySet<ExtraordinaryCauseCode> = new Set([
  "airline_staff_strike",
  "technical_fault",
]);

export function assessExtraordinaryCircumstance(
  causeCode: ExtraordinaryCauseCode | undefined | null,
): ExtraordinaryVerdict {
  if (causeCode === undefined || causeCode === null || causeCode === "unknown") {
    return "unproven";
  }
  if (VALID_DEFENCE_CODES.has(causeCode)) {
    return "valid_defence";
  }
  if (NOT_VALID_DEFENCE_CODES.has(causeCode)) {
    return "not_valid_defence";
  }
  return "unproven";
}
