import {
  CLAIM_FIELD_LABELS,
  provenanceOf,
  type ClaimFieldKey,
  type ClaimFieldProvenance,
} from "./claim-fields.js";

/**
 * Works out, for one carrier's form, which values the system can already fill
 * in and which the human still has to supply.
 *
 * PURE — no I/O, no clock, no LLM (CLAUDE.md §3.1). Callers pass in the facts
 * they hold; this only decides what's covered. That keeps the "have we asked
 * the user for everything?" question exhaustively testable without a database
 * or a graph, which matters because getting it wrong in the optimistic
 * direction means confidently telling someone they have everything they need
 * for a form that will then reject them.
 */

/** Claim facts the pipeline already holds, keyed by canonical field name. */
export interface KnownClaimFacts {
  bookingReference?: string | undefined;
  flightItinerary?: string | undefined;
  disruptionType?: string | undefined;
  passengerNames?: string | undefined;
  compensationAmount?: string | undefined;
}

/** The stored profile's fields, keyed by canonical field name. */
export interface KnownProfileFacts {
  claimantFullName?: string | undefined;
  claimantEmail?: string | undefined;
  claimantPhone?: string | undefined;
  claimantPostalAddress?: string | undefined;
  payoutAccountHolderName?: string | undefined;
  payoutIban?: string | undefined;
  payoutBic?: string | undefined;
}

export interface ResolvedField {
  key: ClaimFieldKey;
  label: string;
  value: string;
}

export interface MissingField {
  key: ClaimFieldKey;
  label: string;
  provenance: ClaimFieldProvenance;
}

export interface PrefillResult {
  /** Fields the system can fill in, in the order the carrier asked for them. */
  resolved: ResolvedField[];
  /**
   * Fields still needed, split by who can answer. `fromProfile` is what to ask
   * the user for ONCE and then store; `perClaim` has to be asked every time and
   * is never worth storing. Keeping them apart is what stops the agent from
   * re-asking for an IBAN it already has, and from trying to "remember" a
   * receipt that belongs to one specific disruption.
   */
  missingFromProfile: MissingField[];
  missingPerClaim: MissingField[];
  /** True when nothing is outstanding — the packet can be presented as complete. */
  complete: boolean;
}

/**
 * `null` requiredFields means nobody catalogued this carrier's form. That is
 * NOT the same as an empty list, and this reflects that: it resolves nothing and
 * reports nothing missing, because claiming either would be a guess. The caller
 * is expected to say so out loud rather than imply the form needs nothing.
 */
export function resolvePrefill(
  requiredFields: readonly ClaimFieldKey[] | null,
  facts: KnownClaimFacts,
  profile: KnownProfileFacts,
): PrefillResult {
  if (requiredFields === null) {
    return { resolved: [], missingFromProfile: [], missingPerClaim: [], complete: false };
  }

  const available: Partial<Record<ClaimFieldKey, string | undefined>> = { ...facts, ...profile };

  const resolved: ResolvedField[] = [];
  const missingFromProfile: MissingField[] = [];
  const missingPerClaim: MissingField[] = [];

  for (const key of requiredFields) {
    const label = CLAIM_FIELD_LABELS[key];
    const value = available[key];

    // Treat blank/whitespace as absent: a stored empty string is the shape the
    // old hardcoded `email: ""` produced, and rendering it as a filled field
    // would be worse than admitting it's missing.
    if (typeof value === "string" && value.trim().length > 0) {
      resolved.push({ key, label, value });
      continue;
    }

    const provenance = provenanceOf(key);
    const missing: MissingField = { key, label, provenance };
    if (provenance === "passenger_profile") {
      missingFromProfile.push(missing);
    } else {
      // claim_state facts that are somehow absent are grouped with per-claim
      // ones: either way the human is the only remaining source.
      missingPerClaim.push(missing);
    }
  }

  return {
    resolved,
    missingFromProfile,
    missingPerClaim,
    complete: missingFromProfile.length === 0 && missingPerClaim.length === 0,
  };
}

/** Convenience for callers that just need to know whether to stop and ask. */
export function hasOutstandingFields(result: PrefillResult): boolean {
  return result.missingFromProfile.length > 0 || result.missingPerClaim.length > 0;
}
