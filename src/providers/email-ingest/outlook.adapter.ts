import { ok, err, type Result } from "../../lib/result.js";
import { extractPdfText } from "../../lib/pdf-text.js";
import type {
  EmailIngestProvider,
  EmailIngestQuery,
  EmailListResult,
  EmailAttachment,
  EmailIngestError,
} from "./email-ingest.port.js";

/**
 * Real adapter against Microsoft Graph (delegated Mail.Read scope, read-only).
 * Uses the documented `Prefer: outlook.body-content-type="text"` header to get
 * plain text bodies directly instead of parsing HTML.
 *
 * Each page already contains full message content (unlike Gmail's list→get
 * split), so pagination here just means following `@odata.nextLink` — no
 * per-message fan-out needed.
 */
const API_BASE = "https://graph.microsoft.com/v1.0/me/messages";
const PAGE_SIZE = 100;
// Safety net against a pathologically broad range turning into an unbounded
// number of pages — not expected to be hit for a normal multi-month scan.
// Injectable (see constructor) so tests can exercise the truncation path.
const DEFAULT_MAX_MESSAGES = 2000;

interface GraphAttachmentMeta {
  name: string;
  contentType: string;
}

interface GraphMessage {
  id: string;
  subject: string;
  receivedDateTime: string;
  from?: { emailAddress?: { address?: string } };
  body?: { content?: string };
  attachments?: GraphAttachmentMeta[];
}

interface GraphMessagesResponse {
  value: GraphMessage[];
  "@odata.nextLink"?: string;
}

interface GraphAttachmentFull {
  name: string;
  contentType: string;
  contentBytes: string;
}

interface GraphAttachmentsResponse {
  value: GraphAttachmentFull[];
}

export class OutlookAdapter implements EmailIngestProvider {
  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly maxMessages: number = DEFAULT_MAX_MESSAGES,
  ) {}

  async listRecentMessages(query: EmailIngestQuery): Promise<Result<EmailListResult, EmailIngestError>> {
    const accessToken = await this.getAccessToken();

    const filterTerms = [`receivedDateTime ge ${query.sinceUtc}`];
    if (query.untilUtc) {
      filterTerms.push(`receivedDateTime le ${query.untilUtc}`);
    }

    const initialUrl = new URL(API_BASE);
    initialUrl.searchParams.set("$filter", filterTerms.join(" and "));
    initialUrl.searchParams.set("$select", "id,from,subject,receivedDateTime,body");
    initialUrl.searchParams.set("$expand", "attachments($select=name,contentType)");
    initialUrl.searchParams.set("$top", String(PAGE_SIZE));

    const graphMessages: GraphMessage[] = [];
    let nextUrl: string | undefined = initialUrl.toString();
    let truncated = false;

    while (nextUrl) {
      const pageResult: Result<GraphMessagesResponse, EmailIngestError> = await this.authedFetch<GraphMessagesResponse>(
        nextUrl,
        accessToken,
      );
      if (!pageResult.ok) {
        return pageResult;
      }
      graphMessages.push(...(pageResult.value.value ?? []));
      nextUrl = pageResult.value["@odata.nextLink"];

      if (nextUrl && graphMessages.length >= this.maxMessages) {
        truncated = true;
        break;
      }
    }

    const messages = graphMessages.slice(0, this.maxMessages).map((m) => ({
      id: m.id,
      from: m.from?.emailAddress?.address ?? "",
      subject: m.subject,
      receivedAtUtc: new Date(m.receivedDateTime).toISOString(),
      bodyText: m.body?.content ?? "",
      attachments: (m.attachments ?? []).map(
        (a): EmailAttachment => ({ filename: a.name, mimeType: a.contentType }),
      ),
    }));

    return ok({ messages, truncated });
  }

  async getAttachmentText(messageId: string, filename: string): Promise<Result<string, EmailIngestError>> {
    const accessToken = await this.getAccessToken();

    const result = await this.authedFetch<GraphAttachmentsResponse>(
      `${API_BASE}/${messageId}/attachments`,
      accessToken,
    );
    if (!result.ok) {
      return result;
    }

    const attachment = result.value.value.find((a) => a.name === filename);
    if (!attachment) {
      return err({ type: "not_found", message: `No attachment named "${filename}" on message ${messageId}` });
    }

    const buffer = Buffer.from(attachment.contentBytes, "base64");

    if (attachment.contentType === "application/pdf") {
      try {
        return ok(await extractPdfText(buffer));
      } catch (cause) {
        return err({ type: "upstream_error", message: `Failed to extract PDF text: ${String(cause)}` });
      }
    }
    if (attachment.contentType.startsWith("text/")) {
      return ok(buffer.toString("utf-8"));
    }
    return err({
      type: "unsupported_attachment",
      message: `Attachment "${filename}" has unsupported type ${attachment.contentType} — only PDF and text are supported`,
    });
  }

  private async authedFetch<T>(url: string, accessToken: string): Promise<Result<T, EmailIngestError>> {
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
      const bodyText = await response.text();
      return err({ type: "upstream_error", message: `Microsoft Graph returned HTTP ${response.status}: ${bodyText}` });
    }

    try {
      return ok((await response.json()) as T);
    } catch (cause) {
      return err({ type: "upstream_error", message: `Malformed Microsoft Graph response: ${String(cause)}` });
    }
  }
}
