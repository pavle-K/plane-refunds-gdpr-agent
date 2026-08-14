import { z } from "zod";
import type { GraphStateType } from "../state.js";
import type { LlmClient } from "../llm/llm.port.js";
import type { AuditLog } from "../../compliance/audit-log.js";
import type { AirlineDirectoryProvider } from "../../providers/airline-directory/airline-directory.port.js";
import {
  buildSubmissionPlan,
  type PresentableChannel,
  type SubmissionPlan,
} from "../../providers/airline-directory/submission-plan.js";
import type { Booking } from "../../domain/claim/claim.types.js";
import type { FlightStatusResult } from "../../providers/flight-status/flight-status.port.js";
import { callStructured } from "../llm/structured.js";
import { prompts } from "../prompts/index.js";

export interface DraftClaimNodeDeps {
  llm: LlmClient;
  airlineDirectory: AirlineDirectoryProvider;
  auditLog: AuditLog;
}

const draftSchema = z.object({ letterText: z.string() });

function formatEuros(cents: number): string {
  // EC261 compensation bands are always whole euros (€250/€400/€600) — see
  // domain/ec261/compensation.ts — so no decimal formatting is needed here.
  return `€${Math.round(cents / 100)}`;
}

function buildItineraryLines(flightStatuses: FlightStatusResult[]): string {
  return flightStatuses
    .map((s) => {
      const disruption =
        s.status === "delayed"
          ? `, ${s.delayMinutesAtArrival ?? "?"} min delay at arrival`
          : s.status === "cancelled"
            ? ", cancelled"
            : "";
      return `  - ${s.flightNumber}: ${s.departureAirportIata} -> ${s.arrivalAirportIata}, scheduled ${s.scheduledDepartureUtc.slice(0, 10)}${disruption}`;
    })
    .join("\n");
}

/**
 * A formal "Dear Sir/Madam" letter is the wrong artifact for a carrier that
 * doesn't accept letters — there is nowhere to paste prose into a web form, and
 * producing one invited exactly the "so it's been sent?" confusion that
 * draftText always risked.
 *
 * This builds a deterministic submission packet instead: what the plan says
 * about the carrier's channels, plus the facts the human will need to supply.
 * No LLM call — every fact here was already computed and verified elsewhere in
 * the pipeline, so this is formatting, not drafting. That distinction matters:
 * the letter path is where a fabricated booking reference came from once, and
 * there is no generative step here to fabricate anything with.
 */
function buildSubmissionPacket(params: {
  booking: Booking;
  flightStatuses: FlightStatusResult[];
  compensationCents: number;
  eligibilityReason: string | null;
  plan: SubmissionPlan;
}): string {
  const { booking, flightStatuses, compensationCents, eligibilityReason, plan } = params;
  const passengerName = booking.passengers[0]?.fullName ?? null;

  const facts = [
    `- Booking reference: ${booking.bookingReference}`,
    ...(passengerName ? [`- Passenger: ${passengerName}`] : []),
    `- Flight(s):\n${buildItineraryLines(flightStatuses)}`,
    `- Compensation to claim: ${formatEuros(compensationCents)} (EC261/2004${eligibilityReason ? ` — ${eligibilityReason}` : ""})`,
  ].join("\n");

  return `${plan.message}\n\nHere are the details you'll need:\n${facts}`;
}

/** True when at least one channel can carry a written letter — email or post.
 * A web form cannot, so a carrier offering only a form gets the packet. */
function acceptsALetter(channels: readonly PresentableChannel[]): boolean {
  return channels.some((channel) => channel.kind === "email" || channel.kind === "postal");
}

/**
 * Handles both the original draft and rebuttal drafts — the same node the
 * pipeline "loops back" to (§2.2). Which mode it's in is read from state: if the
 * last response was classified "rejected", this is a rebuttal.
 *
 * Three outcomes, decided from the submission plan rather than from a single
 * submission-method type:
 *
 *  - No usable channel (carrier unknown, nothing recorded, or only unverified
 *    leads): produce NO draft at all. This is the fix for a real incident — an
 *    unsupported carrier used to fall through to the letter path, and the model
 *    wrote a full formal claim for an airline with nowhere to send it, complete
 *    with an invented booking reference. There is now no generative step on this
 *    path to invent anything with.
 *  - A channel that can carry a letter (email or post): draft one with the LLM.
 *  - Web form only: build the deterministic packet.
 */
export function createDraftClaimNode(deps: DraftClaimNodeDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    if (!state.booking || state.flightStatuses.length === 0 || state.compensationCents === null) {
      throw new Error("draftClaim: booking, flightStatuses, and compensationCents are required");
    }

    const isRebuttal = state.responseClassification?.category === "rejected";

    const lastFlightStatus = state.flightStatuses[state.flightStatuses.length - 1]!;
    const carrierCode = lastFlightStatus.operatingCarrierIataCode;
    const plan = buildSubmissionPlan(carrierCode, await deps.airlineDirectory.getAirline(carrierCode));

    if (plan.selection.type === "none_available") {
      await deps.auditLog.record({
        claimId: state.claimId,
        entryType: "system_action",
        payload: { node: "draftClaim", isRebuttal, outcome: "no_submission_channel", reason: plan.selection.reason },
      });
      return { draftText: null, submission: plan };
    }

    // A rebuttal only exists because a real reply came back, which means a real
    // send happened, which today is only possible on an email channel — so
    // rebuttals always take the letter path. Written as a condition rather than
    // relied on as an assumption, in case that stops being true.
    if (!isRebuttal && !acceptsALetter(plan.channels)) {
      const packet = buildSubmissionPacket({
        booking: state.booking,
        flightStatuses: state.flightStatuses,
        compensationCents: state.compensationCents,
        eligibilityReason: state.eligibilityReason,
        plan,
      });

      await deps.auditLog.record({
        claimId: state.claimId,
        entryType: "system_action",
        payload: { node: "draftClaim", isRebuttal, outcome: "submission_packet", packet },
      });

      return { draftText: packet, submission: plan };
    }

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
      addresseeCarrierName: plan.carrierName,
      evidence: {
        weatherObservation: state.weatherObservation,
        disruptionEvents: state.disruptionEvents,
        extraordinaryCircumstanceVerdict: state.extraordinaryVerdict,
      },
    };

    const payload = isRebuttal
      ? {
          ...basePayload,
          airlineRejectionReason: state.airlineReplyText,
          counterEvidence: {
            weatherObservation: state.weatherObservation,
            disruptionEvents: state.disruptionEvents,
            extraordinaryCircumstanceVerdict: state.extraordinaryVerdict,
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

    return { draftText: letterText, submission: plan };
  };
}
