import { ok, err, type Result } from "../../lib/result.js";
import type { EmailIngestProvider, EmailIngestQuery, EmailMessage, EmailIngestError } from "./email-ingest.port.js";

/**
 * Real adapter against the Gmail API (read-only scope only —
 * https://www.googleapis.com/auth/gmail.readonly). UNVERIFIED against a live
 * response — no connected Gmail account yet. The list→get→parse shape below
 * matches Gmail API v1's documented format; re-verify once scripts/connect-email.ts
 * has been run for real.
 *
 * Gmail's `after:` search operator is DAY granularity, not exact timestamp — a
 * sinceUtc of "14:00" and "23:00" on the same day both just become that day's
 * date. Good enough for polling on a schedule, not for sub-day precision.
 */
const API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

interface GmailMessagePart {
  mimeType: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
}

interface GmailMessageDetail {
  id: string;
  payload: GmailMessagePart & { headers: { name: string; value: string }[] };
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

function extractPlainTextBody(part: GmailMessagePart): string | null {
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const found = extractPlainTextBody(child);
    if (found) {
      return found;
    }
  }
  return null;
}

function getHeader(headers: { name: string; value: string }[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export class GmailAdapter implements EmailIngestProvider {
  constructor(private readonly getAccessToken: () => Promise<string>) {}

  async listRecentMessages(query: EmailIngestQuery): Promise<Result<EmailMessage[], EmailIngestError>> {
    const accessToken = await this.getAccessToken();
    const afterDate = query.sinceUtc.slice(0, 10).replace(/-/g, "/");

    const listUrl = new URL(`${API_BASE}/messages`);
    listUrl.searchParams.set("q", `after:${afterDate}`);

    const listResult = await this.authedFetch(listUrl, accessToken);
    if (!listResult.ok) {
      return listResult;
    }

    const listBody = listResult.value as { messages?: { id: string }[] };
    if (!listBody.messages || listBody.messages.length === 0) {
      return ok([]);
    }

    const messages: EmailMessage[] = [];
    for (const { id } of listBody.messages) {
      const detailResult = await this.authedFetch(new URL(`${API_BASE}/messages/${id}?format=full`), accessToken);
      if (!detailResult.ok) {
        return detailResult;
      }
      const detail = detailResult.value as GmailMessageDetail;
      messages.push({
        id: detail.id,
        from: getHeader(detail.payload.headers, "From"),
        subject: getHeader(detail.payload.headers, "Subject"),
        receivedAtUtc: new Date(getHeader(detail.payload.headers, "Date") || Date.now()).toISOString(),
        bodyText: extractPlainTextBody(detail.payload) ?? "",
      });
    }

    return ok(messages);
  }

  private async authedFetch(url: URL, accessToken: string): Promise<Result<unknown, EmailIngestError>> {
    let response: Response;
    try {
      response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    } catch (cause) {
      return err({ type: "upstream_error", message: `Network error calling Gmail API: ${String(cause)}` });
    }

    if (response.status === 401) {
      return err({ type: "auth_error", message: "Gmail API rejected the access token" });
    }
    if (response.status === 429) {
      return err({ type: "rate_limited", message: "Gmail API rate-limited the request" });
    }
    if (!response.ok) {
      const bodyText = await response.text();
      return err({ type: "upstream_error", message: `Gmail API returned HTTP ${response.status}: ${bodyText}` });
    }

    try {
      return ok(await response.json());
    } catch (cause) {
      return err({ type: "upstream_error", message: `Malformed Gmail API response: ${String(cause)}` });
    }
  }
}
