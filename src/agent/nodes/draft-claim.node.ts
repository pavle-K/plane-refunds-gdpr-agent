import { z } from "zod";
import type { GraphStateType } from "../state.js";
import type { LlmClient } from "../llm/llm.port.js";
import type { AuditLog } from "../../compliance/audit-log.js";
import type {
  AirlineDirectoryProvider,
  AirlineClaimsContact,
  AirlineDirectoryError,
  ClaimSubmissionMethod,
  PassengerFieldKey,
} from "../../providers/airline-directory/airline-directory.port.js";
import type { Booking } from "../../domain/claim/claim.types.js";
import type { FlightStatusResult } from "../../providers/flight-status/flight-status.port.js";
import type { Result } from "../../lib/result.js";
import { callStructured } from "../llm/structured.js";
import { prompts } from "../prompts/index.js";

export interface DraftClaimNodeDeps {
  llm: LlmClient;
  airlineDirectory: AirlineDirectoryProvider;
  auditLog: AuditLog;
}

const draftSchema = z.object({ letterText: z.string() });

const REQUIRED_FIELD_LABELS: Record<PassengerFieldKey, string> = {
  fullName: "full name",
  address: "postal address",
  contactEmail: "contact email",
  phone: "phone number",
  iban: "bank details (IBAN) for the payout",
};

function formatEuros(cents: number): string {
  // EC261 compensation bands are always whole euros (€250/€400/€600) — see
  // domain/ec261/compensation.ts — so no decimal formatting is needed here.
  return `€${Math.round(cents / 100)}`;
}

/**
 * A formal "Dear Sir/Madam" letter is the wrong artifact for a carrier that
 * only accepts claims through its own web form — there's nowhere to paste
 * prose like that, and it invites the same "send it" confusion draftText
 * always risked implying. This builds a plain, deterministic submission
 * packet instead: the form link, the facts the human will need to enter, and
 * an explicit note that automatic form-filling isn't built yet. No LLM call
 * needed — every fact here is already known and verified elsewhere in the
 * pipeline; this is formatting, not drafting.
 */
function buildWebFormSubmissionPacket(params: {
  booking: Booking;
  flightStatuses: FlightStatusResult[];
  compensationCents: number;
  eligibilityReason: string | null;
  carrierName: string;
  method: Extract<ClaimSubmissionMethod, { type: "web_form" }>;
}): string {
  const { booking, flightStatuses, compensationCents, eligibilityReason, carrierName, method } = params;
  const passengerName = booking.passengers[0]?.fullName ?? "Unknown Passenger";

  const itineraryLines = flightStatuses
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

  const fieldsLine =
    method.requiredFields.length > 0
      ? `\nThis form will likely also ask for: ${method.requiredFields.map((f) => REQUIRED_FIELD_LABELS[f]).join(", ")}.`
      : "";

  return (
    `${carrierName} only accepts EC261 claims through their own web form — automatic submission isn't built ` +
    "yet (it's a tracked follow-up), so this has to be submitted by hand for now.\n\n" +
    `Submit it here: ${method.formUrl}\n\n` +
    "Here's what you'll need to enter:\n" +
    `- Booking reference: ${booking.bookingReference}\n` +
    `- Passenger: ${passengerName}\n` +
    `- Flight(s):\n${itineraryLines}\n` +
    `- Compensation to claim: ${formatEuros(compensationCents)} (EC261/2004${eligibilityReason ? ` — ${eligibilityReason}` : ""})` +
    fieldsLine
  );
}

/**
 * Tells the human, at draft time — before they're ever asked to approve —
 * whether this claim can actually be sent automatically. Deliberately does
 * NOT block drafting: something useful is still produced even when a claim
 * can't be auto-sent yet, but "approve" must never be allowed to imply "and
 * it went out" for a carrier this returns non-null for. send-claim.node.ts
 * enforces this independently regardless of whether this warning was shown.
 */
function describeSubmissionWarning(
  airlineResult: Result<AirlineClaimsContact, AirlineDirectoryError>,
): string | null {
  if (!airlineResult.ok) {
    return "I don't have a directory entry for this airline, so I don't yet know how to submit a claim to it automatically.";
  }

  const { submissionMethod, carrierName } = airlineResult.value;
  switch (submissionMethod.type) {
    case "email":
      return null;
    case "web_form":
      return (
        `${carrierName} requires claims to be submitted through their own web form — automatic submission ` +
        "isn't built yet, so I've put together the link and everything you'll need below."
      );
    case "unsupported":
      return (
        `I don't have a sourced/verified way to submit a claim to ${carrierName} yet ` +
        `(${submissionMethod.reason}) — I can prepare the letter for you to send yourself ` +
        "once we know where it needs to go."
      );
  }
}

/**
 * Handles both the original draft and rebuttal drafts — the same node the
 * pipeline "loops back" to (§2.2). Which mode it's in is read from state: if the
 * last response was classified "rejected", this is a rebuttal.
 *
 * Rebuttal mode only ever reaches an LLM-drafted letter: rebutting requires a
 * real airline reply, which requires a real prior send, which is only
 * possible today for an "email" carrier (sendClaim refuses everything else) —
 * so the web-form packet path below is unreachable in rebuttal mode as the
 * graph is wired today. Written to fail safe (fall through to the normal
 * letter path) rather than assume that can never change.
 */
export function createDraftClaimNode(deps: DraftClaimNodeDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    if (!state.booking || state.flightStatuses.length === 0 || state.compensationCents === null) {
      throw new Error("draftClaim: booking, flightStatuses, and compensationCents are required");
    }

    const isRebuttal = state.responseClassification?.category === "rejected";

    const lastFlightStatus = state.flightStatuses[state.flightStatuses.length - 1]!;
    const airlineResult = await deps.airlineDirectory.getAirline(lastFlightStatus.operatingCarrierIataCode);
    const submissionWarning = describeSubmissionWarning(airlineResult);

    if (!isRebuttal && airlineResult.ok && airlineResult.value.submissionMethod.type === "web_form") {
      const packet = buildWebFormSubmissionPacket({
        booking: state.booking,
        flightStatuses: state.flightStatuses,
        compensationCents: state.compensationCents,
        eligibilityReason: state.eligibilityReason,
        carrierName: airlineResult.value.carrierName,
        method: airlineResult.value.submissionMethod,
      });

      await deps.auditLog.record({
        claimId: state.claimId,
        entryType: "system_action",
        payload: { node: "draftClaim", isRebuttal, submissionMethodType: "web_form", packet },
      });

      return { draftText: packet, submissionWarning };
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

    return { draftText: letterText, submissionWarning };
  };
}
