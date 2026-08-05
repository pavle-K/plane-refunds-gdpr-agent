import { z } from "zod";
import type { GraphStateType } from "../state.js";
import type { WeatherProvider } from "../../providers/weather/weather.port.js";
import type { DisruptionProvider } from "../../providers/disruption/disruption.port.js";
import type { LlmClient } from "../llm/llm.port.js";
import type { AuditLog } from "../../compliance/audit-log.js";
import { callStructured } from "../llm/structured.js";
import { prompts } from "../prompts/index.js";
import { assessExtraordinaryCircumstance } from "../../domain/ec261/extraordinary.js";
import { getAirportReference } from "../../domain/ec261/airport-reference.js";

export interface ScoreClaimNodeDeps {
  weather: WeatherProvider;
  disruption: DisruptionProvider;
  llm: LlmClient;
  auditLog: AuditLog;
}

const scoreSchema = z.object({
  successLikelihood: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  citedEvidence: z.array(z.string()),
});

export function createScoreClaimNode(deps: ScoreClaimNodeDeps) {
  return async (state: GraphStateType): Promise<Partial<GraphStateType>> => {
    if (!state.booking || state.flightStatuses.length === 0) {
      throw new Error("scoreClaim: booking and flightStatuses are required");
    }

    // Evidence-gathering targets whichever segment actually drives the disruption
    // type — the cancelled one if any, otherwise the final segment (the one that
    // governs delay eligibility under Folkerts — see check-eligibility.node.ts).
    const relevantSegment =
      state.flightStatuses.find((s) => s.status === "cancelled") ??
      state.flightStatuses[state.flightStatuses.length - 1]!;

    let weatherObservation = null;
    try {
      const ref = getAirportReference(relevantSegment.departureAirportIata);
      const weatherResult = await deps.weather.getObservation({
        icaoCode: ref.icao,
        atUtc: relevantSegment.scheduledDepartureUtc,
      });
      if (weatherResult.ok) {
        weatherObservation = weatherResult.value;
      }
    } catch {
      // Unknown airport reference — proceed without weather evidence.
    }

    const disruptionResult = await deps.disruption.getDisruptions({
      airportIata: relevantSegment.departureAirportIata,
      dateUtc: relevantSegment.scheduledDepartureUtc.slice(0, 10),
    });
    const disruptionEvents = disruptionResult.ok ? disruptionResult.value : [];

    const extraordinaryVerdict = assessExtraordinaryCircumstance(state.causeCode ?? undefined);

    const score = await callStructured(deps.llm, {
      system: prompts.scoreClaim,
      prompt: JSON.stringify({
        eligible: state.eligible,
        compensationCents: state.compensationCents,
        itinerary: state.flightStatuses.map((s) => ({
          flightNumber: s.flightNumber,
          departureAirportIata: s.departureAirportIata,
          arrivalAirportIata: s.arrivalAirportIata,
          delayMinutesAtArrival: s.delayMinutesAtArrival,
          status: s.status,
        })),
        extraordinaryCircumstanceVerdict: extraordinaryVerdict,
        weatherObservation,
        disruptionEvents,
      }),
      schema: scoreSchema,
    });

    await deps.auditLog.record({
      claimId: state.claimId,
      entryType: "llm_output",
      payload: { node: "scoreClaim", score },
    });

    return { weatherObservation, disruptionEvents, extraordinaryVerdict, score };
  };
}
