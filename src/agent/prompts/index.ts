import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PROMPT_FILES = {
  extractBooking: "extract-booking.prompt.md",
  scoreClaim: "score-claim.prompt.md",
  draftClaim: "draft-claim.prompt.md",
  rebut: "rebut.prompt.md",
  classifyResponse: "classify-response.prompt.md",
} as const;

export type PromptName = keyof typeof PROMPT_FILES;

function loadPrompt(fileName: string): string {
  const path = fileURLToPath(new URL(`./${fileName}`, import.meta.url));
  const content = readFileSync(path, "utf-8");
  if (content.trim().length === 0) {
    throw new Error(`Prompt file is empty: ${fileName}`);
  }
  return content;
}

function loadAllPrompts(): Record<PromptName, string> {
  const entries = Object.entries(PROMPT_FILES) as [PromptName, string][];
  const loaded = entries.map(([name, file]) => [name, loadPrompt(file)] as const);
  return Object.fromEntries(loaded) as Record<PromptName, string>;
}

/** Loaded and validated (non-empty) at import time — a missing/empty prompt file
 * fails at boot, not the first time a node tries to use it. */
export const prompts: Record<PromptName, string> = loadAllPrompts();
