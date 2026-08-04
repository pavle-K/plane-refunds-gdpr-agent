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
    if (!state.booking || !state.flightStatus || state.compensationCents === null) {
      throw new Error("draftClaim: booking, flightStatus, and compensationCents are required");
    }

    const isRebuttal = state.responseClassification?.category === "rejected";

    const basePayload = {
      booking: {
        bookingReference: state.booking.bookingReference,
        passengerFullName: state.booking.passengers[0]?.fullName ?? null,
        flightNumber: state.booking.flightNumber,
      },
      flight: {
        departureAirportIata: state.flightStatus.departureAirportIata,
        arrivalAirportIata: state.flightStatus.arrivalAirportIata,
        scheduledDepartureUtc: state.flightStatus.scheduledDepartureUtc,
        delayMinutesAtArrival: state.flightStatus.delayMinutesAtArrival,
        status: state.flightStatus.status,
      },
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
