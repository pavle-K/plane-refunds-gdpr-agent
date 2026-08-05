import { z } from "zod";
import type { GraphStateType } from "../state.js";
import type { LlmClient } from "../llm/client.js";
import type { AuditLog } from "../../compliance/audit-log.js";
import { callStructured } from "../llm/structured.js";
import { prompts } from "../prompts/index.js";

export interface DraftClaimNodeDeps {
  llm: LlmClient;
  auditLog: AuditLog;
}

const draftSchema = z.object({ letterText: z.string() });

/**
 * Handles both the original draft and rebuttal drafts — the same node the
 * pipeline "loops back" to (§2.2). Which mode it's in is read from state: if the
 * last response was classified "rejected", this is a rebuttal.
 */
export function createDraftClaimNode(deps: DraftClaimNodeDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    if (!state.booking || state.flightStatuses.length === 0 || state.compensationCents === null) {
      throw new Error("draftClaim: booking, flightStatuses, and compensationCents are required");
    }

    const isRebuttal = state.responseClassification?.category === "rejected";

    const basePayload = {
      booking: {
        bookingReference: state.booking.bookingReference,
        passengerFullName: state.booking.passengers[0]?.fullName ?? null,
      },
      // Full itinerary, in order — the letter should describe the whole
      // original-departure-to-final-destination trip, not just one leg
      // (Folkerts v Air France, C-11/11: this is one claim for one journey).
      itinerary: state.flightStatuses.map((s) => ({
        flightNumber: s.flightNumber,
        departureAirportIata: s.departureAirportIata,
        arrivalAirportIata: s.arrivalAirportIata,
        scheduledDepartureUtc: s.scheduledDepartureUtc,
        delayMinutesAtArrival: s.delayMinutesAtArrival,
        status: s.status,
      })),
      compensationCents: state.compensationCents,
      eligibilityReasoning: state.eligibilityReason,
      evidence: {
        weatherObservation: state.weatherObservation,
        disruptionEvents: state.disruptionEvents,
        extraordinaryVerdict: state.extraordinaryVerdict,
      },
    };

    const payload = isRebuttal
      ? {
          ...basePayload,
          airlineRejectionReason: state.airlineReplyText,
          counterEvidence: {
            weatherObservation: state.weatherObservation,
            disruptionEvents: state.disruptionEvents,
            extraordinaryVerdict: state.extraordinaryVerdict,
          },
        }
      : basePayload;

    const { letterText } = await callStructured(deps.llm, {
      system: isRebuttal ? prompts.rebut : prompts.draftClaim,
      prompt: JSON.stringify(payload),
      schema: draftSchema,
    });

    await deps.auditLog.record({
      claimId: state.claimId,
      entryType: "llm_output",
      payload: { node: "draftClaim", isRebuttal, letterText },
    });

    return { draftText: letterText };
  };
}
