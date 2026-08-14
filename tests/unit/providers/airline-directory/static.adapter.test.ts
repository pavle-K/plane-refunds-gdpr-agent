import { describe, it, expect } from "vitest";
import { StaticAirlineDirectoryAdapter } from "../../../../src/providers/airline-directory/static.adapter.js";
import { toOperatorAirlineView } from "../../../../src/providers/airline-directory/submission-plan.js";

describe("StaticAirlineDirectoryAdapter", () => {
  it("returns a known EU carrier", async () => {
    const adapter = new StaticAirlineDirectoryAdapter();
    const result = await adapter.getAirline("LH");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.carrierName).toBe("Lufthansa");
      expect(result.value.isEuCarrier).toBe(true);
    }
  });

  it("returns a known non-EU carrier", async () => {
    const adapter = new StaticAirlineDirectoryAdapter();
    const result = await adapter.getAirline("BA");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.carrierName).toBe("British Airways");
      expect(result.value.isEuCarrier).toBe(false);
    }
  });

  it("is case-insensitive on carrier code", async () => {
    const adapter = new StaticAirlineDirectoryAdapter();
    const result = await adapter.getAirline("lh");
    expect(result.ok).toBe(true);
  });

  it("returns a typed not_found error for an unseeded carrier, never a partial object", async () => {
    const adapter = new StaticAirlineDirectoryAdapter();
    const result = await adapter.getAirline("ZZ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("not_found");
    }
  });

  it("withholds the address of any channel nobody has actually loaded", async () => {
    // Iberia's own research note says "Do not ship this URL to users without
    // that check" — iberia.com defeated every automated fetch. The unverified
    // channel variant has no address property at all, so honouring that is a
    // property of the type, not of a check someone has to remember to write.
    const adapter = new StaticAirlineDirectoryAdapter();
    const result = await adapter.getAirline("IB");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.channels).toHaveLength(1);
    expect(result.value.channels.every((c) => c.verification === "unverified")).toBe(true);
    expect(JSON.stringify(result.value)).not.toContain("iberia.com");
  });

  it("exposes a confirmed channel with a resolved absolute URL for carriers that have one", async () => {
    const adapter = new StaticAirlineDirectoryAdapter();
    for (const code of ["EI", "TP", "LH", "BA"]) {
      const result = await adapter.getAirline(code);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      const webForm = result.value.channels.find((c) => c.kind === "web_form");
      expect(webForm, `${code} should have a web_form channel`).toBeDefined();
      if (webForm && webForm.verification !== "unverified" && webForm.kind === "web_form") {
        expect(webForm.url).toMatch(/^https:\/\//);
        // Any {market}/{lang} template must have been substituted at load time.
        expect(webForm.url).not.toMatch(/\{\w+\}/);
      } else {
        expect.fail(`${code}'s web_form channel should be confirmed`);
      }
    }
  });

  it("records carriers that publish more than one route, in preference order", async () => {
    const adapter = new StaticAirlineDirectoryAdapter();
    for (const code of ["BA", "LX"]) {
      const result = await adapter.getAirline(code);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.channels.map((c) => c.kind)).toEqual(["web_form", "postal"]);
    }
  });

  it("marks Ryanair as refusing third-party submissions", async () => {
    // Ryanair runs a registration scheme for claims-management companies and has
    // litigated to force claims through its own channel. Encoded as an enum so
    // the warning shown to a user is rendered from data, not from prose.
    const adapter = new StaticAirlineDirectoryAdapter();
    const result = await adapter.getAirline("FR");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.thirdPartySubmission).toBe("restricted");
    }
  });

  it("distinguishes 'no fields catalogued' from 'asks for no fields'", async () => {
    // Five carriers' forms are JS-rendered and could not be read. Claiming they
    // ask for nothing would be as wrong as guessing an address.
    const adapter = new StaticAirlineDirectoryAdapter();

    const af = await adapter.getAirline("AF");
    expect(af.ok && af.value.channels[0]?.requiredFields.known).toBe(false);

    const ei = await adapter.getAirline("EI");
    expect(ei.ok && ei.value.channels[0]?.requiredFields.known).toBe(true);
    if (ei.ok) {
      const required = ei.value.channels[0]?.requiredFields;
      // Raw tokens fullName/contactEmail/phone/iban, normalised.
      expect(required?.known === true && required.fields).toEqual([
        "claimantFullName",
        "claimantEmail",
        "claimantPhone",
        "payoutIban",
      ]);
    }
  });

  it("listAirlines returns every entry, matching individual getAirline lookups", async () => {
    const adapter = new StaticAirlineDirectoryAdapter();
    const all = await adapter.listAirlines();

    expect(all).toHaveLength(11);
    expect(all.map((a) => a.carrierIataCode).sort()).toEqual(
      ["AF", "AZ", "BA", "EI", "FR", "IB", "KL", "LH", "LX", "TK", "TP"],
    );

    // Still no carrier this system can dispatch to on its own. The one email
    // address in the dataset is ITA's PEC legal mailbox, deliberately excluded
    // from auto-send. This is exactly the fact list_supported_airlines exists to
    // report accurately instead of the operator guessing.
    expect(all.every((a) => toOperatorAirlineView(a).canAutoSend === false)).toBe(true);
  });
});
