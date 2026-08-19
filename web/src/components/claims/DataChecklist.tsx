import type { ReactNode } from "react";
import type { Booking, PassengerProfileResponse } from "../../api/types.js";

const sectionTitleStyle = { fontSize: "0.75rem", textTransform: "uppercase" as const, letterSpacing: "0.03em", color: "var(--text-secondary)", margin: "0 0 0.4rem" };
const rowStyle = { display: "flex", gap: "0.4rem", alignItems: "flex-start", fontSize: "0.85rem", margin: "0.2rem 0" };

function Row({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <div style={rowStyle}>
      <span style={{ color: ok ? "var(--success)" : "var(--text-secondary)", flexShrink: 0 }}>{ok ? "✓" : "○"}</span>
      <span style={{ color: ok ? "var(--text)" : "var(--text-secondary)" }}>{children}</span>
    </div>
  );
}

/** "Required data" / "data provided" — sourced from get_passenger_profile's
 * `missing` list and the claim's own `booking` field (added to
 * OperatorTools.getClaimStatus specifically for this view). Both are the
 * exact same facts the operator LLM already checks before drafting/sending —
 * this just makes them visible without asking in chat. */
export function DataChecklist({ profile, booking }: { profile: PassengerProfileResponse | undefined; booking: Booking | null }) {
  return (
    <div>
      <p style={sectionTitleStyle}>Passenger details</p>
      {!profile || !profile.saved ? (
        <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", margin: 0 }}>
          Nothing saved yet — tell the assistant your name and contact email, or add them in Settings.
        </p>
      ) : (
        <>
          <Row ok>{profile.fullName}</Row>
          <Row ok>{profile.contactEmail}</Row>
          {profile.phone && <Row ok>{profile.phone}</Row>}
          {profile.addressLine1 && <Row ok>{[profile.addressLine1, profile.city, profile.countryIsoCode].filter(Boolean).join(", ")}</Row>}
          {profile.hasIban && <Row ok>Bank details on file</Row>}
          {profile.missing.map((item) => (
            <Row key={item} ok={false}>
              {item}
            </Row>
          ))}
        </>
      )}

      <p style={{ ...sectionTitleStyle, marginTop: "1rem" }}>Flight details</p>
      {!booking ? (
        <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", margin: 0 }}>Not captured yet.</p>
      ) : (
        <>
          <Row ok>Booking reference: {booking.bookingReference}</Row>
          {booking.segments.map((segment, i) => (
            <Row key={i} ok>
              {segment.operatingCarrierCode} {segment.flightNumber} — {segment.departureAirportIata ?? "?"} →{" "}
              {segment.arrivalAirportIata ?? "?"}
            </Row>
          ))}
          {booking.passengers.map((passenger) => (
            <Row key={passenger.id} ok={Boolean(passenger.fullName)}>
              {passenger.fullName ?? "Passenger name not captured"}
            </Row>
          ))}
        </>
      )}
    </div>
  );
}
