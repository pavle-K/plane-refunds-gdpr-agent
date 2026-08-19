import { describe, it, expect } from "vitest";
import { extractWebActions, type ToolCallRecord } from "../../../src/operator/web-actions.js";

describe("extractWebActions", () => {
  it("turns a successful connect_email call into an oauth_popup action", () => {
    const calls: ToolCallRecord[] = [
      {
        name: "connect_email",
        input: { provider: "gmail" },
        result: { authorizationUrl: "https://example.com/authorize", expiresInMinutes: 10 },
      },
    ];

    expect(extractWebActions(calls)).toEqual([
      { type: "oauth_popup", provider: "gmail", authorizationUrl: "https://example.com/authorize" },
    ]);
  });

  it("ignores calls to other tools", () => {
    const calls: ToolCallRecord[] = [{ name: "get_claim_status", input: {}, result: { claimStatus: "draft" } }];
    expect(extractWebActions(calls)).toEqual([]);
  });

  it("ignores a connect_email call whose result has no authorizationUrl", () => {
    const calls: ToolCallRecord[] = [{ name: "connect_email", input: { provider: "gmail" }, result: { error: "boom" } }];
    expect(extractWebActions(calls)).toEqual([]);
  });

  it("ignores a connect_email call with an unrecognized provider", () => {
    const calls: ToolCallRecord[] = [
      { name: "connect_email", input: { provider: "yahoo" }, result: { authorizationUrl: "https://example.com" } },
    ];
    expect(extractWebActions(calls)).toEqual([]);
  });

  it("never throws on a malformed or missing result — e.g. a JSON.parse failure carried through as a raw string", () => {
    const calls: ToolCallRecord[] = [
      { name: "connect_email", input: { provider: "gmail" }, result: "not json" },
      { name: "connect_email", input: { provider: "gmail" }, result: undefined },
      { name: "connect_email", input: {}, result: { authorizationUrl: "https://example.com" } },
    ];
    expect(() => extractWebActions(calls)).not.toThrow();
    expect(extractWebActions(calls)).toEqual([]);
  });

  it("returns one action per matching call, in order, across several tool calls", () => {
    const calls: ToolCallRecord[] = [
      { name: "get_email_connection_status", input: {}, result: { gmail: { connected: false } } },
      { name: "connect_email", input: { provider: "gmail" }, result: { authorizationUrl: "https://example.com/g" } },
      { name: "connect_email", input: { provider: "outlook" }, result: { authorizationUrl: "https://example.com/o" } },
    ];
    expect(extractWebActions(calls)).toEqual([
      { type: "oauth_popup", provider: "gmail", authorizationUrl: "https://example.com/g" },
      { type: "oauth_popup", provider: "outlook", authorizationUrl: "https://example.com/o" },
    ]);
  });
});
