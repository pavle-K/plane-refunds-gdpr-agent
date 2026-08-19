import { useEffect, useState, type FormEvent } from "react";
import { useProfile, useSaveProfile } from "../../api/useProfile.js";
import type { SavePassengerProfileInput } from "../../api/types.js";

type FormState = Required<{ [K in keyof SavePassengerProfileInput]: string }>;

const EMPTY_FORM: FormState = {
  fullName: "",
  contactEmail: "",
  phone: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  postalCode: "",
  countryIsoCode: "",
  iban: "",
  bic: "",
};

const fieldStyle = {
  width: "100%",
  padding: "0.5rem 0.7rem",
  borderRadius: "0.5rem",
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: "0.85rem",
};

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label style={{ display: "block", marginBottom: "0.7rem" }}>
      <span style={{ display: "block", fontSize: "0.78rem", color: "var(--text-secondary)", marginBottom: "0.25rem" }}>{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={fieldStyle} />
    </label>
  );
}

/** Manually adding/editing claim details — the same fields save_passenger_profile
 * accepts. IBAN/BIC always render blank (the backend never returns the raw
 * value, only hasIban/hasBic — see PassengerProfileResponse) — the placeholder
 * shows whether one is already on file, and leaving the field blank on submit
 * keeps whatever's already saved (merge-on-write, not a clear). */
export function ProfileForm() {
  const profile = useProfile();
  const saveProfile = useSaveProfile();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [savedMessage, setSavedMessage] = useState(false);

  useEffect(() => {
    if (!profile.data?.saved) return;
    setForm({
      ...EMPTY_FORM,
      fullName: profile.data.fullName ?? "",
      contactEmail: profile.data.contactEmail ?? "",
      phone: profile.data.phone ?? "",
      addressLine1: profile.data.addressLine1 ?? "",
      addressLine2: profile.data.addressLine2 ?? "",
      city: profile.data.city ?? "",
      postalCode: profile.data.postalCode ?? "",
      countryIsoCode: profile.data.countryIsoCode ?? "",
    });
  }, [profile.data]);

  function set<K extends keyof FormState>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSavedMessage(false);
    const input: SavePassengerProfileInput = {};
    for (const [key, value] of Object.entries(form) as [keyof FormState, string][]) {
      const trimmed = value.trim();
      if (trimmed) {
        input[key] = trimmed;
      }
    }
    saveProfile.mutate(input, {
      onSuccess: () => {
        setSavedMessage(true);
        setForm((prev) => ({ ...prev, iban: "", bic: "" }));
      },
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      <Field label="Full name" value={form.fullName} onChange={(v) => set("fullName", v)} />
      <Field label="Contact email" value={form.contactEmail} onChange={(v) => set("contactEmail", v)} type="email" />
      <Field label="Phone" value={form.phone} onChange={(v) => set("phone", v)} />
      <Field label="Address line 1" value={form.addressLine1} onChange={(v) => set("addressLine1", v)} />
      <Field label="Address line 2" value={form.addressLine2} onChange={(v) => set("addressLine2", v)} />
      <Field label="City" value={form.city} onChange={(v) => set("city", v)} />
      <Field label="Postal code" value={form.postalCode} onChange={(v) => set("postalCode", v)} />
      <Field label="Country (ISO code, e.g. ES)" value={form.countryIsoCode} onChange={(v) => set("countryIsoCode", v)} />
      <Field
        label="IBAN"
        value={form.iban}
        onChange={(v) => set("iban", v)}
        placeholder={profile.data?.hasIban ? "On file — leave blank to keep it" : "Not on file"}
      />
      <Field
        label="BIC / SWIFT"
        value={form.bic}
        onChange={(v) => set("bic", v)}
        placeholder={profile.data?.hasBic ? "On file — leave blank to keep it" : "Not on file"}
      />

      <button
        type="submit"
        disabled={saveProfile.isPending}
        style={{
          padding: "0.55rem 1rem",
          borderRadius: "0.5rem",
          border: "none",
          background: "var(--accent)",
          color: "var(--accent-contrast)",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {saveProfile.isPending ? "Saving…" : "Save"}
      </button>

      {savedMessage && !saveProfile.data?.error && <span style={{ marginLeft: "0.7rem", color: "var(--success)", fontSize: "0.85rem" }}>Saved.</span>}
      {saveProfile.data?.error && <p style={{ color: "var(--danger)", fontSize: "0.85rem", marginTop: "0.5rem" }}>{saveProfile.data.error}</p>}
    </form>
  );
}
