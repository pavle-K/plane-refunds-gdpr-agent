import { describe, it, expect } from "vitest";
import { createIngestNode } from "../../../../src/agent/nodes/ingest.node.js";
import type { BookingExtractor } from "../../../../src/providers/email-ingest/booking-parser.js";
import { buildState } from "../../../helpers/build-state.js";
import type { Booking } from "../../../../src/domain/claim/claim.types.js";

const fixedExtractor: BookingExtractor = async () => ({
  bookingReference: "XR7K2P",
  passengerFullName: "John Smith",
  segments: [{ flightNumber: "BA123", scheduledDepartureDateUtc: "2024-06-15" }],
});

describe("ingest node", () => {
  it("passes through unchanged when booking is already present", async () => {
    const node = createIngestNode({ extractor: fixedExtractor });
    const existing: Booking = {
      bookingReference: "ALREADY",
      passengers: [],
      segments: [
        {
          flightNumber: "BA1",
          operatingCarrierCode: "BA",
          scheduledDepartureUtc: "2024-01-01T00:00:00.000Z",
          scheduledArrivalUtc: "2024-01-01T02:00:00.000Z",
        },
      ],
    };
    const state = buildState({ booking: existing });

    const result = await node(state);
    expect(result).toEqual({});
  });

  it("parses rawEmailText into a booking via the injected extractor", async () => {
    const node = createIngestNode({ extractor: fixedExtractor });
    const state = buildState({ rawEmailText: "Booking reference: XR7K2P ..." });

    const result = await node(state);

    expect(result.booking?.bookingReference).toBe("XR7K2P");
    expect(result.booking?.segments[0]?.flightNumber).toBe("BA123");
    expect(result.booking?.segments[0]?.operatingCarrierCode).toBe("BA");
    expect(result.booking?.passengers[0]?.fullName).toBe("John Smith");
  });

  it("throws if neither booking nor rawEmailText is present", async () => {
    const node = createIngestNode({ extractor: fixedExtractor });
    await expect(node(buildState())).rejects.toThrow();
  });

  it("throws if the extractor cannot find a booking", async () => {
    const nullExtractor: BookingExtractor = async () => null;
    const node = createIngestNode({ extractor: nullExtractor });
    const state = buildState({ rawEmailText: "not a booking" });

    await expect(node(state)).rejects.toThrow();
  });

  it("maps every extracted segment of a connecting itinerary, in order", async () => {
    const connectingExtractor: BookingExtractor = async () => ({
      bookingReference: "TK9F3K",
      passengerFullName: "Jane Doe",
      segments: [
        { flightNumber: "TK1867", scheduledDepartureDateUtc: "2026-01-10" },
        { flightNumber: "TK57", scheduledDepartureDateUtc: "2026-01-10" },
      ],
    });
    const node = createIngestNode({ extractor: connectingExtractor });
    const state = buildState({ rawEmailText: "Booking reference: TK9F3K ..." });

    const result = await node(state);

    expect(result.booking?.segments).toHaveLength(2);
    expect(result.booking?.segments[0]?.flightNumber).toBe("TK1867");
    expect(result.booking?.segments[1]?.flightNumber).toBe("TK57");
  });
});
