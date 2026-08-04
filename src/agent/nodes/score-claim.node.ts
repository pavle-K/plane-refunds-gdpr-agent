import { z } from "zod";
import type { GraphStateType } from "../state.js";
import type { WeatherProvider } from "../../providers/weather/weather.port.js";
import type { DisruptionProvider } from "../../providers/disruption/disruption.port.js";
import type { LlmClient } from "../llm/client.js";
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
    if (!state.booking || !state.flightStatus) {
      throw new Error("scoreClaim: booking and flightStatus are required");
    }

    let weatherObservation = null;
    try {
      const ref = getAirportReference(state.flightStatus.departureAirportIata);
      const weatherResult = await deps.weather.getObservation({
        icaoCode: ref.icao,
        atUtc: state.flightStatus.scheduledDepartureUtc,
      });
      if (weatherResult.ok) {
        weatherObservation = weatherResult.value;
      }
    } catch {
      // Unknown airport reference — proceed without weather evidence.
    }

    const disruptionResult = await deps.disruption.getDisruptions({
      airportIata: state.flightStatus.departureAirportIata,
      dateUtc: state.flightStatus.scheduledDepartureUtc.slice(0, 10),
    });
    const disruptionEvents = disruptionResult.ok ? disruptionResult.value : [];

    const extraordinaryVerdict = assessExtraordinaryCircumstance(state.causeCode ?? undefined);

    const score = await callStructured(deps.llm, {
      system: prompts.scoreClaim,
      prompt: JSON.stringify({
        eligible: state.eligible,
        compensationCents: state.compensationCents,
        flight: {
          flightNumber: state.booking.flightNumber,
          departureAirportIata: state.flightStatus.departureAirportIata,
          arrivalAirportIata: state.flightStatus.arrivalAirportIata,
          delayMinutesAtArrival: state.flightStatus.delayMinutesAtArrival,
          status: state.flightStatus.status,
        },
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
