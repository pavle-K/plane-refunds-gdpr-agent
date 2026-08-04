import { ok, err, type Result } from "../../lib/result.js";
import type { EmailIngestProvider, EmailIngestQuery, EmailMessage, EmailIngestError } from "./email-ingest.port.js";

/**
 * Real adapter against Microsoft Graph (delegated Mail.Read scope, read-only).
 * UNVERIFIED against a live response — no connected Outlook account yet. Uses
 * the documented `Prefer: outlook.body-content-type="text"` header to get plain
 * text bodies directly instead of parsing HTML; re-verify once
 * scripts/connect-email.ts has been run for real.
 */
const API_BASE = "https://graph.microsoft.com/v1.0/me/messages";

interface GraphMessage {
  id: string;
  subject: string;
  receivedDateTime: string;
  from?: { emailAddress?: { address?: string } };
  body?: { content?: string };
}

interface GraphMessagesResponse {
  value: GraphMessage[];
}

export class OutlookAdapter implements EmailIngestProvider {
  constructor(private readonly getAccessToken: () => Promise<string>) {}

  async listRecentMessages(query: EmailIngestQuery): Promise<Result<EmailMessage[], EmailIngestError>> {
    const accessToken = await this.getAccessToken();

    const url = new URL(API_BASE);
    url.searchParams.set("$filter", `receivedDateTime ge ${query.sinceUtc}`);
    url.searchParams.set("$select", "id,from,subject,receivedDateTime,body");

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Prefer: 'outlook.body-content-type="text"',
        },
      });
    } catch (cause) {
      return err({ type: "upstream_error", message: `Network error calling Microsoft Graph: ${String(cause)}` });
    }

    if (response.status === 401) {
      return err({ type: "auth_error", message: "Microsoft Graph rejected the access token" });
    }
    if (response.status === 429) {
      return err({ type: "rate_limited", message: "Microsoft Graph rate-limited the request" });
    }
    if (!response.ok) {
      return err({ type: "upstream_error", message: `Microsoft Graph returned HTTP ${response.status}` });
    }

    let body: GraphMessagesResponse;
    try {
      body = (await response.json()) as GraphMessagesResponse;
    } catch (cause) {
      return err({ type: "upstream_error", message: `Malformed Microsoft Graph response: ${String(cause)}` });
    }

    const messages: EmailMessage[] = (body.value ?? []).map((m) => ({
      id: m.id,
      from: m.from?.emailAddress?.address ?? "",
      subject: m.subject,
      receivedAtUtc: new Date(m.receivedDateTime).toISOString(),
      bodyText: m.body?.content ?? "",
    }));

    return ok(messages);
  }
}
