import type { LlmConversationTurn } from "./llm.port.js";

/**
 * Rough token estimate, not an exact count. This repo is deliberately
 * provider-agnostic (see llm.port.ts's LlmClient — no LangChain model
 * wrappers, no single vendor's tokenizer), so there is no one tokenizer that
 * would even be correct across every configured provider. ~4 characters per
 * token is the standard approximation for English text and is good enough
 * for a truncation BUDGET — it only needs to keep the request roughly under
 * a limit, not bill accurately.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Keeps the most recent turns that fit within maxTokens, dropping the
 * oldest ones first — a fixed message COUNT (the previous approach; see
 * conversation.repo.ts's DEFAULT_HISTORY_LIMIT) doesn't bound token usage at
 * all, since one turn can be a one-word "yes" and another can be a full
 * drafted claim letter. A real conversation (trace.log, 2026-08-14) replayed
 * 40 full turns — including at least one drafted letter — on every single
 * request; this bounds that by an actual budget instead.
 *
 * Always keeps at least the single most recent turn, even if it alone
 * exceeds maxTokens — returning empty history would silently drop context
 * that IS available rather than degrade gracefully.
 */
export function truncateHistoryByTokens(history: LlmConversationTurn[], maxTokens: number): LlmConversationTurn[] {
  const kept: LlmConversationTurn[] = [];
  let usedTokens = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i]!;
    const turnTokens = estimateTokens(turn.content);
    if (kept.length > 0 && usedTokens + turnTokens > maxTokens) {
      break;
    }
    kept.unshift(turn);
    usedTokens += turnTokens;
  }

  return kept;
}
