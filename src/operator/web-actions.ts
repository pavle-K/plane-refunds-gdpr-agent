/**
 * Turns a turn's tool-call activity into structured hints the web frontend
 * can act on beyond plain chat text — today, exactly one: opening a real
 * OAuth popup instead of relying on a link pasted into the reply (see
 * connect_email in src/operator/tools.ts, which returns { authorizationUrl,
 * expiresInMinutes } for exactly this purpose). Pure and defensive on
 * purpose: a tool result reaches here already JSON-round-tripped by
 * session.ts's runAgentTurn (parsed back from the ToolMessage's JSON string,
 * or left as an opaque string/undefined if that parse failed), so this never
 * throws on an unexpected shape — it just omits that call from the result,
 * same as if the tool hadn't been called at all.
 */

export type WebAction = { type: "oauth_popup"; provider: "gmail" | "outlook"; authorizationUrl: string };

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  result: unknown;
}

function isOauthPopupResult(result: unknown): result is { authorizationUrl: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    "authorizationUrl" in result &&
    typeof (result as { authorizationUrl: unknown }).authorizationUrl === "string"
  );
}

function isEmailProvider(value: unknown): value is "gmail" | "outlook" {
  return value === "gmail" || value === "outlook";
}

export function extractWebActions(toolCalls: readonly ToolCallRecord[]): WebAction[] {
  const actions: WebAction[] = [];

  for (const call of toolCalls) {
    if (call.name !== "connect_email") {
      continue;
    }
    if (!isOauthPopupResult(call.result) || !isEmailProvider(call.input["provider"])) {
      continue;
    }
    actions.push({
      type: "oauth_popup",
      provider: call.input["provider"],
      authorizationUrl: call.result.authorizationUrl,
    });
  }

  return actions;
}
