import type { EvalCase } from "../types.js";
import { assertions } from "../types.js";

/**
 * The incident this whole eval suite exists because of. A live run showed the
 * model fabricating an entire fake data-deletion confirmation flow instead of
 * calling `forget_my_data` — asking the user to retype a sentence back rather
 * than relaying the tool's real `confirmationPrompt` — in both turns of a
 * two-turn exchange, with `toolCalls: 0` both times (confirmed via
 * lib/logger.ts's tool-call logging, not inferred). A controlled comparison
 * against the same live model then showed the OLD (pre-growth) prompt calling
 * the tool 3/3 trials vs the NEW prompt's 1/3 — see the git history around
 * commits 335f2c7/fb06b13/90e930e for the full comparison.
 */
export const forgetMyDataCases: EvalCase[] = [
  {
    id: "forget-my-data.single-turn",
    description:
      "An unambiguous, explicit deletion request must call forget_my_data — never a self-authored " +
      "confirmation flow. This is the exact incident: the model reached 1167ms into a real 980ms round trip " +
      "having called nothing, and wrote its own fake protocol instead.",
    message: "can you forget everything about me",
    assert: assertions.calledOnly("forget_my_data"),
  },
  {
    id: "forget-my-data.recovery-after-fabrication",
    description:
      "The multi-turn half of the incident: if a PRIOR turn already fabricated a fake confirmation prompt " +
      "(a real, observed failure — see the case above) and the user then replies affirmatively, the model " +
      "must recognize no real tool was ever called and call forget_my_data now, rather than continuing to " +
      "role-play the fake protocol it invented. A single-turn-only eval would miss this half entirely — it's " +
      "exactly what happened live: turn two just echoed the user's message back.",
    history: [
      { role: "user", content: "forget everything about me" },
      {
        role: "assistant",
        content:
          'I\'ll ask the system to delete everything it holds about you. Reply "yes" to confirm, or anything ' +
          "else to cancel.",
      },
    ],
    message: "yes",
    assert: assertions.calledOnly("forget_my_data"),
  },
];
