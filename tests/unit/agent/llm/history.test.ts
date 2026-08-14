import { describe, expect, it } from "vitest";
import { truncateHistoryByTokens } from "../../../../src/agent/llm/history.js";
import type { LlmConversationTurn } from "../../../../src/agent/llm/llm.port.js";

function turn(role: LlmConversationTurn["role"], content: string): LlmConversationTurn {
  return { role, content };
}

describe("truncateHistoryByTokens", () => {
  it("keeps everything when it already fits the budget", () => {
    const history = [turn("user", "hi"), turn("assistant", "hello")];
    expect(truncateHistoryByTokens(history, 1000)).toEqual(history);
  });

  it("drops the oldest turns first when over budget", () => {
    const history = [
      turn("user", "a".repeat(400)), // oldest — ~100 tokens
      turn("assistant", "b".repeat(40)), // ~10 tokens
      turn("user", "c".repeat(40)), // ~10 tokens, most recent
    ];
    const result = truncateHistoryByTokens(history, 25);
    expect(result).toEqual([history[1], history[2]]);
  });

  it("always keeps at least the single most recent turn, even if it alone exceeds the budget", () => {
    const history = [turn("user", "short"), turn("assistant", "z".repeat(4000))];
    const result = truncateHistoryByTokens(history, 10);
    expect(result).toEqual([history[1]]);
  });

  it("returns an empty array for empty history", () => {
    expect(truncateHistoryByTokens([], 1000)).toEqual([]);
  });

  it("preserves oldest-first order in the kept subset", () => {
    const history = [turn("user", "1"), turn("assistant", "2"), turn("user", "3"), turn("assistant", "4")];
    const result = truncateHistoryByTokens(history, 1000);
    expect(result.map((t) => t.content)).toEqual(["1", "2", "3", "4"]);
  });
});
