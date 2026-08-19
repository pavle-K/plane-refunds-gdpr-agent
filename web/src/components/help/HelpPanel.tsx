const sectionStyle = { marginBottom: "1.1rem" };
const headingStyle = { fontSize: "0.95rem", fontWeight: 600, margin: "0 0 0.3rem" };
const bodyStyle = { fontSize: "0.85rem", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 };

/** Plain-language, human-written summary of what the assistant can actually
 * do — kept in sync with src/operator/tools.ts's real tool set by hand
 * rather than rendered from TOOL_DESCRIPTIONS, which are prompt-engineering
 * instructions written for the model, not reader-facing copy. */
export function HelpPanel() {
  return (
    <div>
      <div style={sectionStyle}>
        <p style={headingStyle}>What this is</p>
        <p style={bodyStyle}>
          An assistant that checks whether a delayed or cancelled EU flight is owed compensation under EC261/2004,
          drafts the claim, and helps you get it to the airline. Nothing is ever sent anywhere without you approving
          it first.
        </p>
      </div>

      <div style={sectionStyle}>
        <p style={headingStyle}>Starting a claim</p>
        <p style={bodyStyle}>
          Just describe the flight in chat — a flight number and date is enough ("BA123 on 15 June was delayed 4
          hours"). You can also connect your Gmail or Outlook inbox (read-only) and ask the assistant to scan it for
          booking confirmations, instead of typing flight details by hand.
        </p>
      </div>

      <div style={sectionStyle}>
        <p style={headingStyle}>Reviewing a draft</p>
        <p style={bodyStyle}>
          Once a claim is eligible, the assistant drafts a letter (or a submission packet, for airlines with only a
          web form). You'll be asked to approve, edit, or decline it — nothing is sent to the airline until you say
          so, in chat or from the claim's Steps tab.
        </p>
      </div>

      <div style={sectionStyle}>
        <p style={headingStyle}>Checking on a claim</p>
        <p style={bodyStyle}>
          Ask "what's the status of my claim" any time, or open it from the Claims list — the Eligibility, Steps,
          Money, Airline, and Data tabs show the same thing chat would tell you, without having to ask.
        </p>
      </div>

      <div style={sectionStyle}>
        <p style={headingStyle}>Your details</p>
        <p style={bodyStyle}>
          Add your name, contact and postal address, and bank details once in Settings (or just tell the assistant),
          and they're reused for every future claim. Bank details are stored encrypted and only ever shown to you as
          "on file", never displayed back in full.
        </p>
      </div>

      <div style={sectionStyle}>
        <p style={headingStyle}>Your data</p>
        <p style={bodyStyle}>
          "Delete all my data" (in Settings or in chat) permanently removes your saved details, chat history, and
          any claim never actually sent to an airline. Claims that were sent — or paid — are kept, since they're a
          real record of a transaction, but with nothing sent to the airline unless you approved it.
        </p>
      </div>
    </div>
  );
}
