import { describe, it, expect } from "vitest";
import { StaticAirlineDirectoryAdapter } from "../../../../src/providers/airline-directory/static.adapter.js";
import {
  buildSubmissionPlan,
  toOperatorAirlineView,
} from "../../../../src/providers/airline-directory/submission-plan.js";

/**
 * Regression suite for a real incident.
 *
 * Ryanair's directory entry carried a maintainer note containing an unconfirmed
 * URL (eu261claims.ryanair.com) alongside the developer-facing instruction "do
 * not encode this URL as fact until someone has actually loaded it". That string
 * was interpolated into a user-facing warning, serialised into a tool result,
 * and read by the operator model as source material — which then told a user to
 * "submit manually using their web form", inventing a channel that did not exist
 * in the data.
 *
 * These tests assert the two structural properties that make that impossible:
 * research prose has nowhere to travel, and an unverified address is never
 * emitted.
 */

/** Everything a caller could ever put in front of the model or the user. */
async function buildPublicOutput(adapter: StaticAirlineDirectoryAdapter): Promise<string> {
  const all = await adapter.listAirlines();
  const parts: string[] = [JSON.stringify(all.map(toOperatorAirlineView))];
  for (const contact of all) {
    const plan = buildSubmissionPlan(contact.carrierIataCode, await adapter.getAirline(contact.carrierIataCode));
    parts.push(JSON.stringify(plan));
  }
  return parts.join("\n");
}

describe("airline directory — LLM safety boundary", () => {
  it("never emits an address for a channel nobody has verified", async () => {
    const adapter = new StaticAirlineDirectoryAdapter();
    const output = await buildPublicOutput(adapter);

    // Iberia: the dataset records a candidate URL and explicitly says not to
    // ship it. It must appear nowhere a user or a model can see.
    expect(output).not.toContain("iberia.com");
  });

  it("never emits a URL that only exists in maintainer research", async () => {
    const adapter = new StaticAirlineDirectoryAdapter();
    const output = await buildPublicOutput(adapter);

    // The exact string from the incident.
    expect(output).not.toContain("eu261claims");
  });

  it("never emits a withheld candidate address for any carrier", async () => {
    const adapter = new StaticAirlineDirectoryAdapter();
    const output = await buildPublicOutput(adapter);
    const all = await adapter.listAirlines();

    for (const contact of all) {
      const research = await adapter.getResearch(contact.carrierIataCode);
      expect(research, `${contact.carrierIataCode} should have a research record`).not.toBeNull();

      // A channel's public URL is legitimately public; anything the loader
      // deliberately set aside is not.
      const publicUrls = new Set(
        contact.channels.flatMap((channel) =>
          channel.verification !== "unverified" && channel.kind === "web_form" ? [channel.url] : [],
        ),
      );

      for (const channelResearch of research?.channels ?? []) {
        for (const candidate of channelResearch.candidateUrls) {
          if (publicUrls.has(candidate)) continue;
          expect(output, `${contact.carrierIataCode}: withheld candidate URL leaked`).not.toContain(candidate);
        }
      }
    }
  });

  it("never emits maintainer verification method or note text", async () => {
    const adapter = new StaticAirlineDirectoryAdapter();
    const output = await buildPublicOutput(adapter);
    const all = await adapter.listAirlines();

    for (const contact of all) {
      const research = await adapter.getResearch(contact.carrierIataCode);
      for (const channelResearch of research?.channels ?? []) {
        expect(output, `${contact.carrierIataCode}: verificationMethod leaked`).not.toContain(
          channelResearch.verificationMethod,
        );
        if (channelResearch.verificationNote) {
          expect(output, `${contact.carrierIataCode}: verificationNote leaked`).not.toContain(
            channelResearch.verificationNote,
          );
        }
      }
    }
  });

  it("never emits the long-form research prose verbatim", async () => {
    const adapter = new StaticAirlineDirectoryAdapter();
    const output = await buildPublicOutput(adapter);
    const all = await adapter.listAirlines();

    // Curated `guidance` legitimately restates short facts from the research in
    // safe language, so a naive substring sweep would false-positive. What must
    // never appear is a long verbatim run of it — that would mean the prose
    // itself was copied through rather than deliberately rewritten.
    for (const contact of all) {
      const research = await adapter.getResearch(contact.carrierIataCode);
      for (const channelResearch of research?.channels ?? []) {
        const notes = channelResearch.notes;
        if (!notes || notes.length < 120) continue;
        for (let i = 0; i + 120 <= notes.length; i += 60) {
          expect(output, `${contact.carrierIataCode}: research prose leaked`).not.toContain(notes.slice(i, i + 120));
        }
      }
    }
  });

  it("keeps the research view off the type that agent nodes and tools receive", async () => {
    // createAirlineDirectoryProvider() declares AirlineDirectoryProvider, which
    // has no getResearch member — so nothing wired through GraphDeps can reach
    // research even though the concrete adapter holds it. This asserts the
    // runtime side of that; the compiler enforces the rest.
    const { createAirlineDirectoryProvider } = await import("../../../../src/providers/airline-directory/index.js");
    const provider = createAirlineDirectoryProvider();

    expect(Object.keys(provider)).not.toContain("getResearch");
    expect(JSON.stringify(await provider.listAirlines())).not.toContain("do not encode");
  });
});
