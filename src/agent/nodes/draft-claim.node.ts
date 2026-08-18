import { z } from "zod";
import type { GraphStateType } from "../state.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AuditLog } from "../../compliance/audit-log.js";
import type { AirlineDirectoryProvider } from "../../providers/airline-directory/airline-directory.port.js";
import { buildSubmissionPlan, type SubmissionPlan } from "../../providers/airline-directory/submission-plan.js";
import type { Booking } from "../../domain/claim/claim.types.js";
import type { FlightStatusResult } from "../../providers/flight-status/flight-status.port.js";
import { resolvePrefill, type PrefillResult } from "../../domain/claim/prefill.js";
import { toKnownClaimFacts, formatEuros } from "../claim-facts.js";
import { callStructured } from "../llm/structured.js";
import { prompts } from "../prompts/index.js";

export interface DraftClaimNodeDeps {
  llm: BaseChatModel;
  airlineDirectory: AirlineDirectoryProvider;
  auditLog: AuditLog;
}

const draftSchema = z.object({ letterText: z.string() });

/**
 * Thrown rather than drafting a letter with nobody's name on it. A claim letter
 * is addressed prose: without a claimant the model fills the gap itself, either
 * with a bracketed placeholder or an invented name, and both have reached real
 * users. Collect the profile first (see the passenger-profile tools) and retry.
 */
export class MissingClaimantDetailsError extends Error {
  constructor() {
    super("draftClaim refused: no claimant name on record — collect the passenger profile before drafting.");
    this.name = "MissingClaimantDetailsError";
  }
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

function renderPrefill(prefill: PrefillResult): string {
  const sections: string[] = [];

  if (prefill.resolved.length > 0) {
    sections.push(
      "Here's what I already have for you:\n" +
        prefill.resolved.map((f) => `- ${f.label}: ${f.value}`).join("\n"),
    );
  }

  const outstanding = [...prefill.missingFromProfile, ...prefill.missingPerClaim];
  if (outstanding.length > 0) {
    sections.push(
      "You'll need to supply these yourself:\n" + outstanding.map((f) => `- ${f.label}`).join("\n"),
    );
  }

  return sections.join("\n\n");
}

/**
 * A formal "Dear Sir/Madam" letter is the wrong artifact for a carrier that
 * doesn't accept letters — there is nowhere to paste prose into a web form, and
 * producing one invited exactly the "so it's been sent?" confusion that
 * draftText always risked.
 *
 * This builds a deterministic submission packet instead: what the plan says
 * about the carrier's channels, every value the system can already fill in, and
 * an explicit list of what is still outstanding. No LLM call — every fact here
 * was computed and verified elsewhere in the pipeline, so this is formatting,
 * not drafting. That distinction matters: the letter path is where a fabricated
 * booking reference came from once, and there is no generative step here to
 * fabricate anything with.
 */
function buildSubmissionPacket(params: {
  booking: Booking;
  flightStatuses: FlightStatusResult[];
  compensationCents: number;
  eligibilityReason: string | null;
  plan: SubmissionPlan;
  prefill: PrefillResult;
}): string {
  const { booking, flightStatuses, compensationCents, eligibilityReason, plan, prefill } = params;

  const claimFacts = [
    `- Booking reference: ${booking.bookingReference}`,
    `- Flight(s):\n${buildItineraryLines(flightStatuses)}`,
    `- Compensation to claim: ${formatEuros(compensationCents)} (EC261/2004${eligibilityReason ? ` — ${eligibilityReason}` : ""})`,
  ].join("\n");

  const prefillSection = renderPrefill(prefill);
  return [`${plan.message}`, `The claim itself:\n${claimFacts}`, prefillSection].filter(Boolean).join("\n\n");
}

/**
 * A letter is only the right artifact when there is exactly ONE route and it can
 * carry prose (email or post).
 *
 * Deliberately NOT "any channel accepts a letter". A carrier offering both a web
 * form and a postal address (British Airways, SWISS) is a choice the human has
 * not made yet — drafting a letter there would quietly presume the postal route,
 * which is the slower one, and leave the form details buried underneath it. The
 * packet presents both routes with the facts for each; the letter follows once a
 * route is actually chosen (tracked as the channel-selection work).
 */
function warrantsALetter(selection: SubmissionPlan["selection"]): boolean {
  return selection.type === "single" && (selection.channel.kind === "email" || selection.channel.kind === "postal");
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
 *  - Exactly one route, and it carries prose (email or post): draft a letter.
 *  - Anything else — a web form, or several routes the human hasn't chosen
 *    between yet: build the deterministic packet.
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

    const claimFacts = toKnownClaimFacts({
      booking: state.booking,
      flightStatuses: state.flightStatuses,
      compensationCents: state.compensationCents,
    });
    // Field requirements are per-channel; the first usable one is what the
    // packet is built around. For a choice_required carrier the plan message
    // still lists every route, so the human sees all of them before picking.
    const primaryChannel = plan.channels.find((channel) => channel.verification !== "unverified");
    // The stored profile wins, but a name already on the booking is real data,
    // not a placeholder — fall back to it rather than asking for something we
    // were just given. Same precedence as the letter path below.
    const bookedName = state.booking.passengers[0]?.fullName ?? undefined;
    const claimant = {
      ...state.claimant,
      claimantFullName: state.claimant?.claimantFullName ?? bookedName,
    };
    const prefill = resolvePrefill(primaryChannel?.requiredFieldKeys ?? null, claimFacts, claimant);

    // A rebuttal only exists because a real reply came back, which means a real
    // send happened, which today is only possible on an email channel — so
    // rebuttals always take the letter path. Written as a condition rather than
    // relied on as an assumption, in case that stops being true.
    if (!isRebuttal && !warrantsALetter(plan.selection)) {
      const packet = buildSubmissionPacket({
        booking: state.booking,
        flightStatuses: state.flightStatuses,
        compensationCents: state.compensationCents,
        prefill,
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

    // Defence in depth, the same reasoning as the approval gate: a letter is
    // addressed prose, so a missing claimant identity comes out as "[Your Name]"
    // or an invented one. Refusing here means "the agent forgot to ask" fails
    // loudly instead of reaching a user as a letter that looks ready to send.
    const claimantName = claimant.claimantFullName ?? null;
    if (!claimantName?.trim()) {
      await deps.auditLog.record({
        claimId: state.claimId,
        entryType: "system_action",
        payload: { node: "draftClaim", isRebuttal, outcome: "missing_claimant_identity" },
      });
      throw new MissingClaimantDetailsError();
    }

    const basePayload = {
      booking: {
        bookingReference: state.booking.bookingReference,
        passengerFullName: claimantName,
        claimantPostalAddress: state.claimant?.claimantPostalAddress ?? null,
        claimantEmail: state.claimant?.claimantEmail ?? null,
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
