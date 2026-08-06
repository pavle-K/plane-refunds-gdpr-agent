import { Command } from "@langchain/langgraph";
import type { LlmToolDefinition } from "../agent/llm/index.js";
import { buildGraph } from "../agent/graph.js";
import { createRealGraphDeps } from "../agent/real-deps.js";
import { runAuthorizationCodeFlow } from "../providers/email-ingest/oauth-flow.js";
import { EMAIL_OAUTH_PROVIDERS } from "../providers/email-ingest/oauth-providers.js";
import { REDIRECT_URI } from "../providers/email-ingest/oauth-redirect-uri.js";
import { EmailConnectionRepo } from "../db/repositories/email-connection.repo.js";
import { createEmailIngestProvider } from "../providers/email-ingest/index.js";
import { looksLikeBookingEmail } from "../providers/email-ingest/booking-parser.js";
import { createLlmBookingExtractor } from "../providers/email-ingest/llm-extractor.js";
import { env } from "../config/env.js";
import type { Booking } from "../domain/claim/claim.types.js";

export const TOOL_DEFINITIONS: LlmToolDefinition[] = [
  {
    name: "connect_email",
    description:
      "Authorizes read-only access to the user's Gmail or Outlook inbox. This opens a browser window for the " +
      "user to log in and approve access — tell them to check their browser before calling this. Only call when " +
      "the user has explicitly asked to connect an email account.",
    inputSchema: {
      type: "object",
      properties: { provider: { type: "string", enum: ["gmail", "outlook"] } },
      required: ["provider"],
    },
  },
  {
    name: "get_email_connection_status",
    description:
      "Checks whether Gmail and/or Outlook are already connected, and which address, before deciding whether to " +
      "call connect_email. Always call this first — never ask the user to connect an account without checking.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "scan_inbox",
    description:
      "Scans the connected inbox for messages in a date range, flags which ones look like flight booking " +
      "confirmations, and extracts structured booking details from those. Requires connect_email to have been " +
      "run first. If the user gives an explicit period (a month, 'February and March', specific dates), use " +
      "startDate/endDate for exactly that range — do NOT fall back to daysBack when they've specified a range.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "Start of an explicit range, YYYY-MM-DD. Use with endDate." },
        endDate: { type: "string", description: "End of an explicit range, YYYY-MM-DD (inclusive)." },
        daysBack: {
          type: "number",
          description: "How many days back from today to search. Only used when startDate/endDate aren't given. Defaults to 30.",
        },
      },
    },
  },
  {
    name: "start_claim",
    description:
      "Starts a new EC261 compensation claim for a trip and runs it through eligibility checking, scoring, and " +
      "drafting. Pass ALL segments of the itinerary in order (first departure to final destination) — for a " +
      "connecting flight, that's more than one segment; a direct flight is just one. Never split a connecting " +
      "itinerary into separate claims: EC261 eligibility is judged on the FINAL destination's arrival delay for " +
      "the whole trip (Folkerts v Air France, C-11/11), not any individual leg. Only flightNumber and date are " +
      "required per segment — the pipeline looks up departure/arrival airports, the operating carrier, and the " +
      "actual delay/cancellation status itself from the flight number and date, so do NOT ask the user for " +
      "airport codes or a carrier code; just call this with what you already extracted. Returns the eligibility " +
      "result and, if eligible, the drafted claim letter for the user to review — do NOT treat this as sent or " +
      "approved, it always needs a separate explicit decision.",
    inputSchema: {
      type: "object",
      properties: {
        segments: {
          type: "array",
          description: "Flight segments in order, first departure to final arrival.",
          items: {
            type: "object",
            properties: {
              flightNumber: { type: "string", description: "IATA flight number, e.g. TK1867" },
              date: { type: "string", description: "Scheduled departure date of this segment, YYYY-MM-DD" },
              departureAirportIata: { type: "string", description: "Optional — looked up automatically if omitted." },
              arrivalAirportIata: { type: "string", description: "Optional — looked up automatically if omitted." },
              carrierCode: {
                type: "string",
                description: "Optional IATA carrier code, e.g. TK — derived from the flight number if omitted.",
              },
            },
            required: ["flightNumber", "date"],
          },
        },
        bookingReference: { type: "string" },
        passengerFullName: { type: "string" },
      },
      required: ["segments"],
    },
  },
  {
    name: "submit_approval_decision",
    description:
      "Submits the human's decision on a drafted claim that's waiting for approval. ONLY call this when the " +
      "user has explicitly and unambiguously stated their decision in their most recent message — never infer " +
      "approval from silence, a vague reaction, or a request to 'see it again'. If they asked for changes, use " +
      "action 'edit' with the full corrected letter text, not just the requested change.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Omit to use the most recently started/touched claim." },
        action: { type: "string", enum: ["approve", "edit", "decline"] },
        editedText: { type: "string", description: "Required when action is 'edit' — the full replacement letter text." },
      },
      required: ["action"],
    },
  },
  {
    name: "get_claim_status",
    description: "Checks the current status of a claim thread, including what it's currently waiting on, if anything.",
    inputSchema: {
      type: "object",
      properties: { threadId: { type: "string", description: "Omit to use the most recently started/touched claim." } },
    },
  },
  {
    name: "submit_airline_reply",
    description:
      "Provides the airline's reply text for a claim that's waiting for a response, so it can be classified " +
      "and routed (accepted/rejected/needs more info). Omit replyText to signal a timeout (no reply received).",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Omit to use the most recently started/touched claim." },
        replyText: { type: "string" },
      },
    },
  },
  {
    name: "submit_payment_confirmation",
    description: "Confirms the airline actually paid, triggering the commission split and payout.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Omit to use the most recently started/touched claim." },
        receivedAmountCents: { type: "number" },
        connectedAccountId: { type: "string", description: "Stripe Connect account id to pay out to." },
      },
      required: ["receivedAmountCents", "connectedAccountId"],
    },
  },
];

export class OperatorTools {
  private readonly deps = createRealGraphDeps();
  private readonly graph = buildGraph(this.deps);
  private lastThreadId: string | null = null;

  private resolveThreadId(threadId?: string): string {
    const id = threadId ?? this.lastThreadId;
    if (!id) {
      throw new Error("No claim thread specified and none started yet this session.");
    }
    return id;
  }

  private config(threadId: string) {
    return { configurable: { thread_id: threadId } };
  }

  async dispatch(name: string, input: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "connect_email":
        return this.connectEmail(input["provider"] as "gmail" | "outlook");
      case "get_email_connection_status":
        return this.getEmailConnectionStatus();
      case "scan_inbox":
        return this.scanInbox(input as unknown as ScanInboxInput);
      case "start_claim":
        return this.startClaim(input as unknown as StartClaimInput);
      case "submit_approval_decision":
        return this.submitApprovalDecision(input as unknown as ApprovalInput);
      case "get_claim_status":
        return this.getClaimStatus(input["threadId"] as string | undefined);
      case "submit_airline_reply":
        return this.submitAirlineReply(input["threadId"] as string | undefined, input["replyText"] as string | undefined);
      case "submit_payment_confirmation":
        return this.submitPaymentConfirmation(input as unknown as PaymentInput);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private async connectEmail(provider: "gmail" | "outlook") {
    if (!env.TOKEN_ENCRYPTION_KEY) {
      return { error: "TOKEN_ENCRYPTION_KEY is not set in .env — cannot store tokens." };
    }
    const clientId = provider === "gmail" ? env.GMAIL_OAUTH_CLIENT_ID : env.OUTLOOK_OAUTH_CLIENT_ID;
    const clientSecret = provider === "gmail" ? env.GMAIL_OAUTH_CLIENT_SECRET : env.OUTLOOK_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return { error: `${provider.toUpperCase()}_OAUTH_CLIENT_ID/_SECRET not set in .env.` };
    }

    const setup = EMAIL_OAUTH_PROVIDERS[provider];
    const config = setup.buildConfig(clientId, clientSecret, REDIRECT_URI);
    const tokens = await runAuthorizationCodeFlow(config);
    const emailAddress = await setup.fetchEmailAddress(tokens.accessToken);

    const repo = new EmailConnectionRepo();
    await repo.upsert({
      provider,
      emailAddress,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAtUtc: tokens.expiresAtUtc,
    });

    return { connected: true, provider, emailAddress };
  }

  private async getEmailConnectionStatus() {
    const repo = new EmailConnectionRepo();
    const [gmail, outlook] = await Promise.all([repo.findByProvider("gmail"), repo.findByProvider("outlook")]);
    return {
      gmail: gmail ? { connected: true, emailAddress: gmail.emailAddress } : { connected: false },
      outlook: outlook ? { connected: true, emailAddress: outlook.emailAddress } : { connected: false },
    };
  }

  private async scanInbox(input: ScanInboxInput) {
    const provider = await createEmailIngestProvider();
    if (provider.constructor.name === "FakeEmailIngestAdapter") {
      return { error: "No inbox connected — call connect_email first." };
    }

    const sinceUtc = input.startDate
      ? `${input.startDate}T00:00:00.000Z`
      : new Date(Date.now() - (input.daysBack ?? 30) * 24 * 60 * 60 * 1000).toISOString();
    const untilUtc = input.endDate ? `${input.endDate}T23:59:59.999Z` : undefined;

    const result = await provider.listRecentMessages({ sinceUtc, ...(untilUtc ? { untilUtc } : {}) });
    if (!result.ok) {
      return { error: `Failed to list messages: ${result.error.type} — ${result.error.message}` };
    }

    const { messages, truncated } = result.value;
    const extractor = createLlmBookingExtractor(this.deps.llm);
    const candidates = [];
    for (const message of messages) {
      if (!looksLikeBookingEmail(message.bodyText)) {
        continue;
      }
      const parsed = await extractor(message, (filename) => provider.getAttachmentText(message.id, filename));
      candidates.push({
        subject: message.subject,
        from: message.from,
        receivedAtUtc: message.receivedAtUtc,
        parsedBooking: parsed,
      });
    }

    return {
      totalMessages: messages.length,
      bookingCandidates: candidates,
      truncated,
      ...(truncated
        ? { warning: "More messages exist beyond an internal safety cap — this range wasn't fully covered. Narrow the date range for complete results." }
        : {}),
    };
  }

  private async startClaim(input: StartClaimInput) {
    if (!input.segments || input.segments.length === 0) {
      return { error: "start_claim requires at least one segment." };
    }

    const threadId = `claim-${Date.now()}`;
    this.lastThreadId = threadId;

    const booking: Booking = {
      bookingReference: input.bookingReference ?? `CHAT-${Date.now()}`,
      passengers: [{ id: "passenger-1", fullName: input.passengerFullName ?? "Unknown Passenger", email: "" }],
      segments: input.segments.map((s) => ({
        flightNumber: s.flightNumber,
        // IATA flight numbers start with the 2-letter carrier code — derive it
        // when not given rather than asking the user for something already
        // implied by the flight number they provided.
        operatingCarrierCode: s.carrierCode ?? s.flightNumber.slice(0, 2).toUpperCase(),
        ...(s.departureAirportIata ? { departureAirportIata: s.departureAirportIata } : {}),
        ...(s.arrivalAirportIata ? { arrivalAirportIata: s.arrivalAirportIata } : {}),
        scheduledDepartureUtc: `${s.date}T00:00:00.000Z`,
        scheduledArrivalUtc: `${s.date}T00:00:00.000Z`,
      })),
    };

    const result = (await this.graph.invoke(
      { claimId: threadId, claimStatus: "draft", booking },
      this.config(threadId),
    )) as Record<string, unknown>;

    return { threadId, ...this.summarize(result) };
  }

  private async submitApprovalDecision(input: ApprovalInput) {
    const threadId = this.resolveThreadId(input.threadId);
    this.lastThreadId = threadId;

    if (input.action === "edit" && !input.editedText) {
      return { error: "action 'edit' requires editedText with the full replacement letter." };
    }

    const decision =
      input.action === "edit"
        ? { action: "edit" as const, editedText: input.editedText! }
        : { action: input.action };

    const result = (await this.graph.invoke(
      new Command({ resume: decision }),
      this.config(threadId),
    )) as Record<string, unknown>;

    return { threadId, ...this.summarize(result) };
  }

  private async getClaimStatus(threadId?: string) {
    const id = this.resolveThreadId(threadId);
    const state = await this.graph.getState(this.config(id));
    return {
      threadId: id,
      claimStatus: state.values.claimStatus,
      pausedOn: state.next[0] ?? null,
      draftText: state.values.draftText,
      escalationReason: state.values.escalationReason,
      payout: state.values.payout,
    };
  }

  private async submitAirlineReply(threadId: string | undefined, replyText: string | undefined) {
    const id = this.resolveThreadId(threadId);
    this.lastThreadId = id;

    const resumeValue = replyText ? { type: "reply" as const, airlineReplyText: replyText } : { type: "timeout" as const };
    const result = (await this.graph.invoke(new Command({ resume: resumeValue }), this.config(id))) as Record<
      string,
      unknown
    >;
    return { threadId: id, ...this.summarize(result) };
  }

  private async submitPaymentConfirmation(input: PaymentInput) {
    const threadId = this.resolveThreadId(input.threadId);
    this.lastThreadId = threadId;

    const result = (await this.graph.invoke(
      new Command({ resume: { receivedAmountCents: input.receivedAmountCents, connectedAccountId: input.connectedAccountId } }),
      this.config(threadId),
    )) as Record<string, unknown>;
    return { threadId, ...this.summarize(result) };
  }

  private summarize(result: Record<string, unknown>) {
    return {
      claimStatus: result["claimStatus"],
      eligible: result["eligible"],
      eligibilityReason: result["eligibilityReason"],
      compensationCents: result["compensationCents"],
      draftText: result["draftText"],
      pausedOn: result["__interrupt__"] ? "waiting for input — describe what's needed based on claimStatus" : null,
      escalationReason: result["escalationReason"],
      payout: result["payout"],
    };
  }
}

interface ScanInboxInput {
  startDate?: string;
  endDate?: string;
  daysBack?: number;
}

interface StartClaimSegmentInput {
  flightNumber: string;
  date: string;
  departureAirportIata?: string;
  arrivalAirportIata?: string;
  carrierCode?: string;
}

interface StartClaimInput {
  segments: StartClaimSegmentInput[];
  bookingReference?: string;
  passengerFullName?: string;
}

interface ApprovalInput {
  threadId?: string;
  action: "approve" | "edit" | "decline";
  editedText?: string;
}

interface PaymentInput {
  threadId?: string;
  receivedAmountCents: number;
  connectedAccountId: string;
}
