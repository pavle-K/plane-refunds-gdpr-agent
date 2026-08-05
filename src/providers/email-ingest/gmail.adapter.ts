import { ok, err, type Result } from "../../lib/result.js";
import { mapWithConcurrency } from "../../lib/concurrency.js";
import { extractPdfText } from "../../lib/pdf-text.js";
import type {
  EmailIngestProvider,
  EmailIngestQuery,
  EmailListResult,
  EmailAttachment,
  EmailIngestError,
} from "./email-ingest.port.js";

/**
 * Real adapter against the Gmail API (read-only scope only —
 * https://www.googleapis.com/auth/gmail.readonly). Verified against a live
 * response — see gmail.adapter.test.ts and the earlier live scan.
 *
 * Gmail's `after:`/`before:` search operators are DAY granularity, not exact
 * timestamp — a sinceUtc of "14:00" and "23:00" on the same day both just
 * become that day's date. Good enough for polling on a schedule or scanning a
 * date range, not for sub-day precision.
 *
 * `messages.list` only returns IDs — full content needs one `messages.get`
 * call per message, fetched with bounded concurrency below (not sequential,
 * not unbounded-parallel) since a multi-month scan can easily return
 * hundreds of messages.
 */
const API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const LIST_PAGE_SIZE = 500; // Gmail API's max per page
const DETAIL_FETCH_CONCURRENCY = 8;
// Safety net against a pathologically broad range (e.g. "since 2015") turning
// into thousands of individual detail fetches — not expected to be hit for a
// normal multi-month scan. Injectable (see constructor) so tests can exercise
// the truncation path without actually hitting 2000 messages.
const DEFAULT_MAX_MESSAGES = 2000;

interface GmailMessagePart {
  mimeType: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string };
  parts?: GmailMessagePart[];
}

interface GmailMessageDetail {
  id: string;
  payload: GmailMessagePart & { headers: { name: string; value: string }[] };
}

interface GmailListResponse {
  messages?: { id: string }[];
  nextPageToken?: string;
}

interface GmailAttachmentResponse {
  data: string;
}

function decodeBase64Url(data: string): Buffer {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64");
}

function extractPlainTextBody(part: GmailMessagePart): string | null {
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data).toString("utf-8");
  }
  for (const child of part.parts ?? []) {
    const found = extractPlainTextBody(child);
    if (found) {
      return found;
    }
  }
  return null;
}

function extractAttachments(part: GmailMessagePart): EmailAttachment[] {
  const attachments: EmailAttachment[] = [];
  if (part.filename && part.body?.attachmentId) {
    attachments.push({ filename: part.filename, mimeType: part.mimeType });
  }
  for (const child of part.parts ?? []) {
    attachments.push(...extractAttachments(child));
  }
  return attachments;
}

function findAttachmentPart(part: GmailMessagePart, filename: string): GmailMessagePart | null {
  if (part.filename === filename && part.body?.attachmentId) {
    return part;
  }
  for (const child of part.parts ?? []) {
    const found = findAttachmentPart(child, filename);
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
  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly maxMessages: number = DEFAULT_MAX_MESSAGES,
  ) {}

  async listRecentMessages(query: EmailIngestQuery): Promise<Result<EmailListResult, EmailIngestError>> {
    const accessToken = await this.getAccessToken();
    const idsResult = await this.listAllMessageIds(query, accessToken);
    if (!idsResult.ok) {
      return idsResult;
    }
    const { ids, truncated } = idsResult.value;
    if (ids.length === 0) {
      return ok({ messages: [], truncated });
    }

    const detailResults = await mapWithConcurrency(ids, DETAIL_FETCH_CONCURRENCY, (id) =>
      this.authedFetch(new URL(`${API_BASE}/messages/${id}?format=full`), accessToken),
    );

    const firstError = detailResults.find((r): r is { ok: false; error: EmailIngestError } => !r.ok);
    if (firstError) {
      return firstError;
    }

    const messages = detailResults.map((r) => {
      if (!r.ok) {
        throw new Error("unreachable: errors already filtered out above");
      }
      const detail = r.value as GmailMessageDetail;
      return {
        id: detail.id,
        from: getHeader(detail.payload.headers, "From"),
        subject: getHeader(detail.payload.headers, "Subject"),
        receivedAtUtc: new Date(getHeader(detail.payload.headers, "Date") || Date.now()).toISOString(),
        bodyText: extractPlainTextBody(detail.payload) ?? "",
        attachments: extractAttachments(detail.payload),
      };
    });

    return ok({ messages, truncated });
  }

  async getAttachmentText(messageId: string, filename: string): Promise<Result<string, EmailIngestError>> {
    const accessToken = await this.getAccessToken();

    const detailResult = await this.authedFetch(new URL(`${API_BASE}/messages/${messageId}?format=full`), accessToken);
    if (!detailResult.ok) {
      return detailResult;
    }
    const detail = detailResult.value as GmailMessageDetail;

    const part = findAttachmentPart(detail.payload, filename);
    if (!part?.body?.attachmentId) {
      return err({ type: "not_found", message: `No attachment named "${filename}" on message ${messageId}` });
    }

    const attachmentResult = await this.authedFetch(
      new URL(`${API_BASE}/messages/${messageId}/attachments/${part.body.attachmentId}`),
      accessToken,
    );
    if (!attachmentResult.ok) {
      return attachmentResult;
    }
    const { data } = attachmentResult.value as GmailAttachmentResponse;
    const buffer = decodeBase64Url(data);

    if (part.mimeType === "application/pdf") {
      try {
        return ok(await extractPdfText(buffer));
      } catch (cause) {
        return err({ type: "upstream_error", message: `Failed to extract PDF text: ${String(cause)}` });
      }
    }
    if (part.mimeType.startsWith("text/")) {
      return ok(buffer.toString("utf-8"));
    }
    return err({
      type: "unsupported_attachment",
      message: `Attachment "${filename}" has unsupported type ${part.mimeType} — only PDF and text are supported`,
    });
  }

  private async listAllMessageIds(
    query: EmailIngestQuery,
    accessToken: string,
  ): Promise<Result<{ ids: string[]; truncated: boolean }, EmailIngestError>> {
    const afterDate = query.sinceUtc.slice(0, 10).replace(/-/g, "/");
    const searchTerms = [`after:${afterDate}`];
    if (query.untilUtc) {
      searchTerms.push(`before:${query.untilUtc.slice(0, 10).replace(/-/g, "/")}`);
    }

    const ids: string[] = [];
    let pageToken: string | undefined;
    let truncated = false;

    do {
      const listUrl = new URL(`${API_BASE}/messages`);
      listUrl.searchParams.set("q", searchTerms.join(" "));
      listUrl.searchParams.set("maxResults", String(LIST_PAGE_SIZE));
      if (pageToken) {
        listUrl.searchParams.set("pageToken", pageToken);
      }

      const listResult = await this.authedFetch(listUrl, accessToken);
      if (!listResult.ok) {
        return listResult;
      }

      const listBody = listResult.value as GmailListResponse;
      ids.push(...(listBody.messages ?? []).map((m) => m.id));
      pageToken = listBody.nextPageToken;

      if (pageToken && ids.length >= this.maxMessages) {
        truncated = true;
        break;
      }
    } while (pageToken);

    return ok({ ids: ids.slice(0, this.maxMessages), truncated });
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
