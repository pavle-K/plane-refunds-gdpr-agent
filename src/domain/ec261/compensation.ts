import { EC261_DISTANCE_BANDS_KM, EC261_COMPENSATION_CENTS } from "../../config/constants.js";

export class InvalidDistanceError extends Error {
  constructor(distanceKm: number) {
    super(`Invalid distance for compensation calculation: ${distanceKm}`);
    this.name = "InvalidDistanceError";
  }
}

/**
 * Distance-band → compensation, in cents. Bands are inclusive at their upper bound:
 * <= 1,500 km, <= 3,500 km, > 3,500 km. Never returns a default/zero amount for
 * invalid input — a wrong amount here is a legal and financial error, not a bug to
 * paper over.
 */
export function getCompensationCents(distanceKm: number): number {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    throw new InvalidDistanceError(distanceKm);
  }

  if (distanceKm <= EC261_DISTANCE_BANDS_KM.SHORT_MAX) {
    return EC261_COMPENSATION_CENTS.SHORT_HAUL;
  }
  if (distanceKm <= EC261_DISTANCE_BANDS_KM.MEDIUM_MAX) {
    return EC261_COMPENSATION_CENTS.MEDIUM_HAUL;
  }
  return EC261_COMPENSATION_CENTS.LONG_HAUL;
}
