/**
 * EC261/2004 thresholds, retention windows, and timeouts.
 * These are constants only — the logic that consumes them lives in src/domain/ (Stage 1).
 */

export const EC261_DELAY_THRESHOLD_MINUTES = 180; // 3h, measured on arrival

// Simplification: EC261 Art. 5(1)(c) actually tiers by 14/7 days plus rerouting-time
// offered, not a single cutoff. This binary threshold covers the common case; the
// rerouting-time nuance needs additional inputs not yet modeled — revisit before
// this is relied on for cancellations notified 7–14 days out with rerouting offered.
export const EC261_CANCELLATION_NOTICE_THRESHOLD_DAYS = 14;

export const EC261_DISTANCE_BANDS_KM = {
  SHORT_MAX: 1500,
  MEDIUM_MAX: 3500,
} as const;

export const EC261_COMPENSATION_CENTS = {
  SHORT_HAUL: 25000, // <= 1,500 km
  MEDIUM_HAUL: 40000, // 1,501–3,500 km
  LONG_HAUL: 60000, // > 3,500 km
} as const;

// Per-country limitation periods and airline response timeouts are jurisdiction-specific
// and get filled in with sourced values during Stage 1 (src/domain/claim/deadlines.ts).
export const AIRLINE_RESPONSE_TIMEOUT_DAYS = 14;

// GDPR retention: how long PII is kept past a claim's resolution before purge.
// Placeholder pending legal review in Stage 1/3 (src/compliance/retention.ts).
export const PII_RETENTION_DAYS_POST_RESOLUTION = 180;

// Placeholder business decision, not a technical constant — revisit with whoever
// owns pricing before this reflects a real commission rate. 2500 = 25%.
export const DEFAULT_COMMISSION_RATE_BASIS_POINTS = 2500;

// Rebuttal loop bound — prevents rebut→send→classify cycling indefinitely (§5.3).
export const MAX_REBUTTAL_ATTEMPTS = 2;
