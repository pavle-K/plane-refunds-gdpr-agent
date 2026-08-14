import { randomUUID } from "node:crypto";
import { Command } from "@langchain/langgraph";
import type { LlmToolDefinition } from "../agent/llm/index.js";
import { buildGraph } from "../agent/graph.js";
import { createRealGraphDeps } from "../agent/real-deps.js";
import { getCheckpointer } from "../agent/checkpointer.js";
import { buildHostedAuthorizationUrl } from "../providers/email-ingest/hosted-oauth.js";
import { EMAIL_OAUTH_PROVIDERS } from "../providers/email-ingest/oauth-providers.js";
import { EmailConnectionRepo, type EmailProviderName } from "../db/repositories/email-connection.repo.js";
import { ClaimRepo } from "../db/repositories/claim.repo.js";
import { PassengerProfileRepo, type PassengerProfile } from "../db/repositories/passenger-profile.repo.js";
import type { KnownProfileFacts } from "../domain/claim/prefill.js";
import { ConversationRepo } from "../db/repositories/conversation.repo.js";
import { ConsentRepo } from "../db/repositories/consent.repo.js";
import { PendingConfirmationRepo, type ConfirmableActionType } from "../db/repositories/pending-confirmation.repo.js";
import { DbAuditLog } from "../compliance/audit-log.js";
import { createEmailIngestProvider, FakeEmailIngestAdapter } from "../providers/email-ingest/index.js";
import { toOperatorAirlineView } from "../providers/airline-directory/submission-plan.js";
import { looksLikeBookingEmail } from "../providers/email-ingest/booking-parser.js";
import { createLlmBookingExtractor } from "../providers/email-ingest/llm-extractor.js";
import type { Booking } from "../domain/claim/claim.types.js";

/** Claim statuses that mean nothing was ever actually sent to an airline —
 * safe to fully delete on a forget_my_data request. Everything else (sent
 * and beyond) is a real transaction/correspondence, kept for the legal-claims
 * and financial record-keeping reasons GDPR Art. 17(3) allows for.
 * "needs_manual_submission" belongs here too: it means the carrier has no
 * automated send path, so THIS SYSTEM never dispatched anything — the human
 * may have gone and submitted it themselves elsewhere, but that's outside
 * this app's own transaction record (see human-approval.node.ts). */
const PRE_SEND_CLAIM_STATUSES = new Set(["draft", "pending_approval", "declined", "needs_manual_submission"]);

/** How long a forget_my_data/disconnect_email confirmation request stays
 * live — short on purpose: this only ever needs to survive to the very next
 * message, and a short window limits how long a stray later "yes" (said for
 * an unrelated reason) could theoretically land inside it. */
const PENDING_CONFIRMATION_TTL_MINUTES = 5;

/** Thrown by resolveThreadId when a threadId doesn't exist or belongs to a
 * different user. Deliberately worded the same either way — this is an
 * internal chat tool, not a public API, but there's still no reason to
 * confirm to a caller that a *different* user's claim thread exists. */
export class ClaimAuthorizationError extends Error {
  constructor(threadId: string) {
    super(`No claim thread "${threadId}" found for this user.`);
    this.name = "ClaimAuthorizationError";
  }
}

export const TOOL_DEFINITIONS: LlmToolDefinition[] = [
  {
    name: "connect_email",
    description:
      "Returns a link that authorizes read-only access to the user's Gmail or Outlook inbox. Does NOT wait for " +
      "them to complete it — send them the link and stop there; you'll be told separately, in a later message, " +
      "once it's actually connected. Only call when the user has explicitly asked to connect an email account.",
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
      "result, a `submission` object saying how (or whether) a claim can actually reach this airline, and — when " +
      "there is something to review — draftText. Do NOT treat any of this as sent or approved; it always needs a " +
      "separate explicit decision, and for most carriers approving still cannot dispatch anything automatically.",
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
    name: "list_supported_airlines",
    description:
      "Returns every airline this system knows about and every route by which a claim can currently reach each " +
      "one — their own web form, email, post, or nothing confirmed yet. This is the ONLY correct way to answer a " +
      "general question like 'which airlines can you send to automatically' or 'what about Lufthansa/Ryanair/etc' " +
      "— never answer that kind of question from memory or a guess; call this and relay exactly what it returns. " +
      "A carrier with no channel listed genuinely has none on record: say it isn't supported, don't go looking " +
      "for a form URL from memory.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_passenger_profile",
    description:
      "Returns the claim details saved for this user (name, contact details, postal address, bank details) and " +
      "which of them are still missing. Call this BEFORE drafting or presenting a claim — the airline's form " +
      "will ask for these, and a claim prepared without them is incomplete. Never invent or assume any of these " +
      "values; if something is missing, ask the user for it.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "save_passenger_profile",
    description:
      "Saves or updates the user's claim details so they don't have to be re-entered on every claim. Only pass " +
      "fields the user has ACTUALLY given you in this conversation — never fill one in from a guess, from a " +
      "similar-looking value, or from what a form 'usually' wants. Omitted fields keep their saved value. " +
      "Requires the user to have provided at least a full name and a contact email the first time.",
    inputSchema: {
      type: "object",
      properties: {
        fullName: { type: "string" },
        contactEmail: { type: "string" },
        phone: { type: "string" },
        addressLine1: { type: "string" },
        addressLine2: { type: "string" },
        city: { type: "string" },
        postalCode: { type: "string" },
        countryIsoCode: { type: "string", description: "ISO 3166-1 alpha-2, e.g. ES" },
        iban: { type: "string", description: "Only when the user has actually supplied it — never derive one." },
        bic: { type: "string", description: "BIC/SWIFT. Some airlines (SWISS) require it alongside the IBAN." },
      },
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
  {
    name: "disconnect_email",
    description:
      "Requests disconnecting the user's Gmail or Outlook inbox. Does NOT disconnect it immediately — this only " +
      "starts a confirmation the system itself handles on the user's next message; it returns a confirmationPrompt " +
      "you must relay to the user VERBATIM (do not paraphrase, shorten, or add to it). Do not tell the user it's " +
      "done, and do not call this tool again to 'confirm' — you have no way to confirm it yourself, only the " +
      "user's own next reply does that. Only call when the user explicitly asks to disconnect or remove access " +
      "to an email account.",
    inputSchema: {
      type: "object",
      properties: { provider: { type: "string", enum: ["gmail", "outlook"] } },
      required: ["provider"],
    },
  },
  {
    name: "forget_my_data",
    description:
      "Requests deleting the user's data held by this bot. Does NOT delete anything immediately — this only " +
      "starts a confirmation the system itself handles on the user's next message; it returns a " +
      "confirmationPrompt you must relay to the user VERBATIM (do not paraphrase, shorten, or add to it). Do not " +
      "tell the user their data is deleted, and do not call this tool again to 'confirm' — you have no way to " +
      "confirm it yourself, only the user's own next reply does that. Only call when the user has explicitly and " +
      "unambiguously asked to delete/forget their data — never speculatively, and never from an ambiguous or " +
      "joking remark.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** Maps a stored profile onto the canonical claim-field vocabulary the prefill
 * resolver speaks. Address lines are joined into the single postal-address fact
 * a form asks for. */
function toClaimantFacts(profile: PassengerProfile): KnownProfileFacts {
  const addressParts = [profile.addressLine1, profile.addressLine2, profile.postalCode, profile.city, profile.countryIsoCode];
  const postalAddress = addressParts.filter((part): part is string => Boolean(part?.trim())).join(", ");

  return {
    claimantFullName: profile.fullName,
    claimantEmail: profile.contactEmail,
    ...(profile.phone ? { claimantPhone: profile.phone } : {}),
    ...(postalAddress ? { claimantPostalAddress: postalAddress } : {}),
    ...(profile.iban ? { payoutIban: profile.iban, payoutAccountHolderName: profile.fullName } : {}),
    ...(profile.bic ? { payoutBic: profile.bic } : {}),
  };
}

export class OperatorTools {
  private readonly deps = createRealGraphDeps();
  private readonly graph = buildGraph(this.deps);
  private readonly claimRepo = new ClaimRepo();

  /** The user this instance acts on behalf of — every email-connection lookup
   * and claim-ownership check is scoped to this id. channelIdentityId is the
   * specific chat connect_email was called from, recorded on the pending
   * OAuth flow so the callback route knows where to send the "you're
   * connected" confirmation.
   *
   * Deliberately no per-conversation in-memory state on this class (see the
   * removed lastThreadId) — a fresh instance is constructed per turn
   * (src/operator/session.ts), so any request can land on any horizontally
   * scaled process and still work: "the most recently touched claim"
   * (resolveThreadId below) is a DB query, not instance memory. */
  constructor(
    private readonly userId: string,
    private readonly channelIdentityId: string,
  ) {}

  /** Resolves an explicit threadId (verifying the calling user owns it) or,
   * if omitted, looks up the claim this user most recently touched —
   * inherently already scoped to this.userId, so no separate ownership check
   * is needed on that path. Either way, every caller of this method is about
   * to read or act on a LangGraph thread, and none of that should happen
   * without this. */
  private async resolveThreadId(threadId?: string): Promise<string> {
    if (threadId) {
      const claim = await this.claimRepo.findById(threadId);
      if (!claim || claim.userId !== this.userId) {
        throw new ClaimAuthorizationError(threadId);
      }
      return threadId;
    }

    const mostRecent = await this.claimRepo.findMostRecentForUser(this.userId);
    if (!mostRecent) {
      throw new Error("No claim thread specified and none started yet.");
    }
    return mostRecent.id;
  }

  private config(threadId: string) {
    return { configurable: { thread_id: threadId } };
  }

  /** Keeps the claims ownership+status mirror (schema.ts's `claims` table)
   * current after every action that can move a claim forward — both so
   * get_claim_status-adjacent tooling reflects reality, and so
   * ClaimRepo.findMostRecentForUser (resolveThreadId's fallback when no
   * threadId is given) reflects the claim the user actually last acted on,
   * not just the one they started. */
  private async updateClaimStatusMirror(threadId: string, result: Record<string, unknown>): Promise<void> {
    const status = typeof result["claimStatus"] === "string" ? result["claimStatus"] : "unknown";
    await this.claimRepo.updateStatus(threadId, status);
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
      case "list_supported_airlines":
        return this.listSupportedAirlines();
      case "get_passenger_profile":
        return this.getPassengerProfile();
      case "save_passenger_profile":
        return this.savePassengerProfile(input as PassengerProfileToolInput);
      case "submit_airline_reply":
        return this.submitAirlineReply(input["threadId"] as string | undefined, input["replyText"] as string | undefined);
      case "submit_payment_confirmation":
        return this.submitPaymentConfirmation(input as unknown as PaymentInput);
      case "disconnect_email":
        return this.requestDisconnectEmail(input["provider"] as EmailProviderName);
      case "forget_my_data":
        return this.requestForgetMyData();
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * Executes a confirmed forget_my_data/disconnect_email request — called
   * ONLY from src/operator/session.ts's deterministic pending-confirmation
   * handling, never from dispatch() and never reachable by the LLM. This is
   * the one and only path that actually deletes/disconnects anything; an LLM
   * calling disconnect_email or forget_my_data can never reach it directly,
   * no matter what it generates or claims.
   */
  async executeConfirmedAction(actionType: ConfirmableActionType, actionParams: Record<string, unknown>): Promise<unknown> {
    switch (actionType) {
      case "forget_my_data":
        return this.forgetMyData();
      case "disconnect_email":
        return this.disconnectEmail(actionParams["provider"] as EmailProviderName);
      default:
        throw new Error(`Unknown confirmable action type: ${String(actionType)}`);
    }
  }

  /** Returns a link immediately — does not block waiting for the user to
   * complete it. The public callback route (src/api/routes/oauth.routes.ts)
   * finishes the flow out-of-band and sends a proactive "connected" message
   * back to this same chat once it does. */
  private async connectEmail(provider: "gmail" | "outlook") {
    const { authorizationUrl, expiresInMinutes } = await buildHostedAuthorizationUrl(
      this.userId,
      this.channelIdentityId,
      provider,
    );
    return { authorizationUrl, expiresInMinutes };
  }

  private async getEmailConnectionStatus() {
    const repo = new EmailConnectionRepo();
    const [gmail, outlook] = await Promise.all([
      repo.findByUserAndProvider(this.userId, "gmail"),
      repo.findByUserAndProvider(this.userId, "outlook"),
    ]);
    return {
      gmail: gmail ? { connected: true, emailAddress: gmail.emailAddress } : { connected: false },
      outlook: outlook ? { connected: true, emailAddress: outlook.emailAddress } : { connected: false },
    };
  }

  /** Mirrors get_email_connection_status: a cheap read the model is told to do
   * before acting, so it never asks the user for something already on record.
   * Reports what's missing explicitly rather than returning a sparse object the
   * model has to interpret. */
  private async getPassengerProfile() {
    const profile = await new PassengerProfileRepo().findByUserId(this.userId);
    if (!profile) {
      return { saved: false as const, missing: ["full name", "contact email"] };
    }

    const missing: string[] = [];
    if (!profile.addressLine1) missing.push("postal address");
    if (!profile.phone) missing.push("phone number");
    if (!profile.iban) missing.push("bank details (IBAN)");
    if (!profile.bic) missing.push("BIC/SWIFT code");

    return {
      saved: true as const,
      fullName: profile.fullName,
      contactEmail: profile.contactEmail,
      phone: profile.phone ?? null,
      addressLine1: profile.addressLine1 ?? null,
      addressLine2: profile.addressLine2 ?? null,
      city: profile.city ?? null,
      postalCode: profile.postalCode ?? null,
      countryIsoCode: profile.countryIsoCode ?? null,
      // The stored values are returned so the model can show the user what's on
      // record, but bank details are reported as present/absent only — there is
      // no reason for an IBAN to pass back through a model's context to answer
      // "have you got my details?".
      hasIban: Boolean(profile.iban),
      hasBic: Boolean(profile.bic),
      missing,
    };
  }

  /**
   * Merge-on-write: reads the existing profile and applies only the fields the
   * caller actually supplied. That keeps "update just my phone number" working
   * without the model having to echo back every other field — and echoing them
   * back is exactly where it would have the opportunity to alter one.
   */
  private async savePassengerProfile(input: PassengerProfileToolInput) {
    const repo = new PassengerProfileRepo();
    const existing = await repo.findByUserId(this.userId);

    const fullName = input.fullName ?? existing?.fullName;
    const contactEmail = input.contactEmail ?? existing?.contactEmail;
    if (!fullName || !contactEmail) {
      return { error: "A full name and a contact email are required before a profile can be saved." };
    }

    await repo.upsert(this.userId, {
      fullName,
      contactEmail,
      phone: input.phone ?? existing?.phone,
      addressLine1: input.addressLine1 ?? existing?.addressLine1,
      addressLine2: input.addressLine2 ?? existing?.addressLine2,
      city: input.city ?? existing?.city,
      postalCode: input.postalCode ?? existing?.postalCode,
      countryIsoCode: input.countryIsoCode ?? existing?.countryIsoCode,
      iban: input.iban ?? existing?.iban,
      bic: input.bic ?? existing?.bic,
    });

    return this.getPassengerProfile();
  }

  /** Starts (does not execute) a disconnect_email confirmation — see
   * schema.ts's pending_confirmations doc comment for why execution is
   * deliberately not reachable from here. */
  private async requestDisconnectEmail(provider: EmailProviderName) {
    const connection = await new EmailConnectionRepo().findByUserAndProvider(this.userId, provider);
    if (!connection) {
      return { status: "not_connected" as const };
    }

    await new PendingConfirmationRepo().create({
      userId: this.userId,
      channelIdentityId: this.channelIdentityId,
      actionType: "disconnect_email",
      actionParams: { provider },
      expiresAtUtc: new Date(Date.now() + PENDING_CONFIRMATION_TTL_MINUTES * 60_000),
    });

    return {
      status: "confirmation_required" as const,
      confirmationPrompt:
        `This will disconnect ${connection.emailAddress} (${provider}) and revoke authorization with the ` +
        `provider where possible. Reply "yes" to confirm, or anything else to cancel.`,
    };
  }

  /** Starts (does not execute) a forget_my_data confirmation, having already
   * looked up exactly what would be deleted vs. kept so the confirmation
   * prompt is accurate — see schema.ts's pending_confirmations doc comment
   * for why execution is deliberately not reachable from here. */
  private async requestForgetMyData() {
    const emailRepo = new EmailConnectionRepo();
    const connectedEmails: string[] = [];
    for (const provider of ["gmail", "outlook"] as const) {
      const connection = await emailRepo.findByUserAndProvider(this.userId, provider);
      if (connection) {
        connectedEmails.push(connection.emailAddress);
      }
    }

    const allClaims = await this.claimRepo.findAllForUser(this.userId);
    const deletableClaimCount = allClaims.filter((c) => PRE_SEND_CLAIM_STATUSES.has(c.status)).length;
    const keptClaimCount = allClaims.length - deletableClaimCount;

    const profile = await new PassengerProfileRepo().findByUserId(this.userId);

    const willDelete = ["your chat history", "your consent record"];
    if (profile) {
      // Named explicitly, and bank details called out separately: "your saved
      // details" is too vague for someone deciding whether to confirm.
      willDelete.push(
        profile.iban || profile.bic
          ? "your saved claim details (name, contact details, address and bank details)"
          : "your saved claim details (name, contact details and address)",
      );
    }
    if (connectedEmails.length > 0) {
      willDelete.push(`your connected email (${connectedEmails.join(", ")})`);
    }
    if (deletableClaimCount > 0) {
      willDelete.push(`${deletableClaimCount} claim(s) never sent to an airline`);
    }

    let prompt = `This will permanently delete: ${willDelete.join(", ")}. This cannot be undone.`;
    if (keptClaimCount > 0) {
      prompt +=
        ` ${keptClaimCount} claim(s) that were actually sent (or paid out) will be kept, along with the audit ` +
        `log, for legal/financial record-keeping required by law.`;
    }
    prompt += ` Reply "yes" to confirm, or anything else to cancel.`;

    await new PendingConfirmationRepo().create({
      userId: this.userId,
      channelIdentityId: this.channelIdentityId,
      actionType: "forget_my_data",
      actionParams: {},
      expiresAtUtc: new Date(Date.now() + PENDING_CONFIRMATION_TTL_MINUTES * 60_000),
    });

    return { status: "confirmation_required" as const, confirmationPrompt: prompt };
  }

  /** Revokes with the provider where supported (Gmail; not Outlook — see
   * oauth-providers.ts) and deletes the local connection regardless of
   * whether revocation succeeded — a token we can't invalidate is still a
   * token we shouldn't keep holding onto. Only reachable via
   * executeConfirmedAction — see that method's doc comment. */
  private async disconnectEmail(provider: EmailProviderName) {
    const repo = new EmailConnectionRepo();
    const connection = await repo.findByUserAndProvider(this.userId, provider);
    if (!connection) {
      return { disconnected: false, reason: "not_connected" as const };
    }

    const setup = EMAIL_OAUTH_PROVIDERS[provider];
    const revokedWithProvider = setup.revokeToken ? await setup.revokeToken(connection.refreshToken).catch(() => false) : false;

    await repo.delete(this.userId, provider);
    await new DbAuditLog().record({
      userId: this.userId,
      entryType: "email_disconnected",
      payload: { provider, emailAddress: connection.emailAddress, revokedWithProvider },
    });

    return {
      disconnected: true,
      provider,
      emailAddress: connection.emailAddress,
      revokedWithProvider,
      ...(revokedWithProvider
        ? {}
        : {
            note:
              `Could not automatically revoke this with ${provider === "gmail" ? "Google" : "Microsoft"} — the ` +
              "stored connection is removed on our end, but tell the user they can also revoke it themselves via " +
              "their account's security settings for full assurance.",
          }),
    };
  }

  /**
   * Deletes everything that has no legal reason to be retained (email
   * connection, chat history, consent record, any claim never actually sent
   * to an airline) and keeps everything that does (a claim that WAS sent or
   * paid out, and the audit log) — see GDPR Art. 17(3)'s legal-claims and
   * legal-obligation exceptions to the right to erasure. Reports exactly
   * what was kept and why so the caller can relay that plainly rather than
   * silently keeping data the user asked to have deleted. Only reachable via
   * executeConfirmedAction — see that method's doc comment.
   */
  private async forgetMyData() {
    const emailRepo = new EmailConnectionRepo();
    const disconnectedEmails: { provider: EmailProviderName; emailAddress: string; revokedWithProvider: boolean }[] = [];
    for (const provider of ["gmail", "outlook"] as const) {
      const connection = await emailRepo.findByUserAndProvider(this.userId, provider);
      if (!connection) {
        continue;
      }
      const setup = EMAIL_OAUTH_PROVIDERS[provider];
      const revokedWithProvider = setup.revokeToken
        ? await setup.revokeToken(connection.refreshToken).catch(() => false)
        : false;
      await emailRepo.delete(this.userId, provider);
      disconnectedEmails.push({ provider, emailAddress: connection.emailAddress, revokedWithProvider });
    }

    const checkpointer = getCheckpointer();
    const allClaims = await this.claimRepo.findAllForUser(this.userId);
    const deletedClaimIds: string[] = [];
    const keptClaimIds: string[] = [];
    for (const claim of allClaims) {
      if (PRE_SEND_CLAIM_STATUSES.has(claim.status)) {
        // Deletes the raw booking/passenger PII in the LangGraph checkpointer,
        // not just this app's own ownership/status mirror row — the claims
        // table was never the full record (see schema.ts).
        await checkpointer.deleteThread(claim.id);
        await this.claimRepo.delete(claim.id);
        deletedClaimIds.push(claim.id);
      } else {
        keptClaimIds.push(claim.id);
      }
    }

    await new ConversationRepo().deleteHistory(this.channelIdentityId);
    await new ConsentRepo().deleteForUser(this.userId);
    // Unconditional, unlike claims: a profile is not itself a record of a
    // transaction with a third party, and a claim that WAS sent already carries
    // the name and address inside its stored letter text for the audit trail.
    await new PassengerProfileRepo().deleteForUser(this.userId);

    await new DbAuditLog().record({
      userId: this.userId,
      entryType: "data_erasure",
      payload: { disconnectedEmails, deletedClaimIds, keptClaimIds },
    });

    return {
      erased: true,
      disconnectedEmails,
      deletedClaimCount: deletedClaimIds.length,
      keptClaims:
        keptClaimIds.length > 0
          ? {
              count: keptClaimIds.length,
              reason:
                "These claims were actually sent to an airline (or paid out) — kept for legal/financial " +
                "record-keeping required by law, not because the request wasn't honored.",
            }
          : null,
      note:
        "Chat history, your saved claim details (including any bank details) and the consent record are " +
        "deleted. The audit log (proof the human-approval gate was followed for any sent claim) is kept for " +
        "the same legal reasons as sent claims.",
    };
  }

  private async scanInbox(input: ScanInboxInput) {
    const provider = await createEmailIngestProvider(this.userId);
    // instanceof, not a constructor.name string compare: the name check was
    // silently dependent on class names surviving the build, and any bundler
    // that mangles them would have turned "no inbox connected" into a live
    // scan against a fake provider.
    if (provider instanceof FakeEmailIngestAdapter) {
      // The factory also falls back to the fake when TOKEN_ENCRYPTION_KEY is
      // unset (see email-ingest/index.ts), which connect_email cannot fix —
      // so the message names both causes rather than sending the user round a
      // loop that can't succeed.
      return {
        error:
          "No inbox is connected for this user — call connect_email first. (If the user has already " +
          "connected one, this server is missing its TOKEN_ENCRYPTION_KEY configuration and cannot read " +
          "stored mailbox credentials; that's an operator-side problem the user cannot fix by reconnecting.)",
      };
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

    // randomUUID, not Date.now(): bookingReference is UNIQUE per user (see
    // schema.ts + migration 0007), and prompt.md explicitly tells the model to
    // call start_claim once per booking IN THE SAME TURN when several are
    // checked together. Millisecond resolution is not enough to keep those
    // apart — two references generated in the same millisecond would either
    // collide on the unique index or, worse, make the second booking look like
    // a re-check of the first and return the WRONG claim's stored result.
    const bookingReference = input.bookingReference ?? `CHAT-${randomUUID()}`;

    // A booking reference this user has already checked is authoritative —
    // never trust the model to re-derive flight/date facts it already
    // extracted once. This is the fix for a real incident: asked to
    // "check the ryanair one" again, the model silently re-called this with
    // today's date instead of the flight's actual date, got a genuine "not
    // found" for that wrong date, and then fabricated an answer to paper
    // over the contradiction rather than admit it. Returning the EXISTING
    // claim's real stored result — ignoring whatever this call's inputs are —
    // makes that entire failure mode structurally impossible: the system,
    // not the model's memory, decides what "the ryanair one" actually is.
    const existing = await this.claimRepo.findByBookingReference(this.userId, bookingReference);
    if (existing) {
      const state = await this.graph.getState(this.config(existing.id));
      return {
        threadId: existing.id,
        flightNumbers: input.segments.map((s) => s.flightNumber),
        bookingReference,
        recheckedExistingClaim: true,
        note:
          "This booking reference was already checked in a previous call — returning that SAME claim's real " +
          "stored result. The flight/date given in this call were ignored; they cannot change what's already on " +
          "record for this booking. If something here looks different from what you expected, trust this, not " +
          "your memory of the earlier turn.",
        ...this.summarize(state.values as unknown as Record<string, unknown>),
      };
    }

    // Same reason as bookingReference above — this is the claims table's primary
    // key, and `claim-${Date.now()}` collided on claims_pkey whenever two claims
    // started within the same millisecond.
    const threadId = `claim-${randomUUID()}`;
    // Recorded before graph.invoke, not after — if invoke fails partway, an
    // orphan ownership row pointing at a thread that never actually started
    // is harmless; the reverse (a thread that exists in the checkpointer with
    // no ownership row) would permanently lock its own creator out of it via
    // resolveThreadId's ownership check.
    await this.claimRepo.create(threadId, this.userId, bookingReference, "draft");

    // Loaded here, not in the node: the graph has no notion of a user, so only
    // this user-scoped layer can resolve a profile. Absent is a normal early
    // state — draftClaim reports the resulting gaps rather than inventing values.
    const profile = await new PassengerProfileRepo().findByUserId(this.userId);
    const claimant = profile ? toClaimantFacts(profile) : null;

    const booking: Booking = {
      bookingReference,
      // No "Unknown Passenger" fallback. That placeholder used to render into
      // user-facing claim letters as though it were the passenger's real name.
      passengers: [
        {
          id: "passenger-1",
          fullName: input.passengerFullName ?? profile?.fullName ?? null,
          email: profile?.contactEmail ?? null,
        },
      ],
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
      { claimId: threadId, claimStatus: "draft", booking, claimant },
      this.config(threadId),
    )) as Record<string, unknown>;
    await this.updateClaimStatusMirror(threadId, result);

    // flightNumbers/bookingReference are echoed back deliberately: when the
    // model checks several bookings in one turn (see prompt.md), each tool
    // result must be self-labeled with which flight it's about. Without
    // this, the model has to correlate results back to flights purely from
    // memory/call-order across several tool responses — a real incident
    // showed it can misattribute one flight's delay/eligibility onto
    // another when composing a combined summary. This doesn't make that
    // impossible, but it removes the need to rely on memory for it.
    return {
      threadId,
      flightNumbers: input.segments.map((s) => s.flightNumber),
      bookingReference: booking.bookingReference,
      ...this.summarize(result),
    };
  }

  private async submitApprovalDecision(input: ApprovalInput) {
    const threadId = await this.resolveThreadId(input.threadId);

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
    await this.updateClaimStatusMirror(threadId, result);

    return { threadId, ...this.summarize(result) };
  }

  private async getClaimStatus(threadId?: string) {
    const id = await this.resolveThreadId(threadId);
    const state = await this.graph.getState(this.config(id));
    return {
      threadId: id,
      claimStatus: state.values.claimStatus,
      // awaitingInput has the same meaning and shape here as in summarize()
      // below, so both tool surfaces answer "is this waiting on someone?" the
      // same way. pausedOn additionally names the node, which is only knowable
      // from a checkpoint read like this one.
      awaitingInput: state.next.length > 0,
      pausedOn: state.next[0] ?? null,
      eligible: state.values.eligible,
      eligibilityReason: state.values.eligibilityReason,
      compensationCents: state.values.compensationCents,
      draftText: state.values.draftText,
      submission: state.values.submission,
      escalationReason: state.values.escalationReason,
      payout: state.values.payout,
    };
  }

  /** Grounds a general "which airlines support what" question in the real
   * directory data instead of the model guessing — see this tool's
   * description in TOOL_DEFINITIONS for why that matters.
   *
   * Goes through toOperatorAirlineView rather than spreading the contact: that
   * projection is what strips unverified addresses and is structurally unable to
   * carry maintainer research (see providers/airline-directory/maintenance.ts). */
  private async listSupportedAirlines() {
    const airlines = await this.deps.airlineDirectory.listAirlines();
    return {
      airlines: airlines
        .map(toOperatorAirlineView)
        .sort((a, b) => a.carrierName.localeCompare(b.carrierName)),
    };
  }

  private async submitAirlineReply(threadId: string | undefined, replyText: string | undefined) {
    const id = await this.resolveThreadId(threadId);

    const resumeValue = replyText ? { type: "reply" as const, airlineReplyText: replyText } : { type: "timeout" as const };
    const result = (await this.graph.invoke(new Command({ resume: resumeValue }), this.config(id))) as Record<
      string,
      unknown
    >;
    await this.updateClaimStatusMirror(id, result);
    return { threadId: id, ...this.summarize(result) };
  }

  private async submitPaymentConfirmation(input: PaymentInput) {
    const threadId = await this.resolveThreadId(input.threadId);

    const result = (await this.graph.invoke(
      new Command({ resume: { receivedAmountCents: input.receivedAmountCents, connectedAccountId: input.connectedAccountId } }),
      this.config(threadId),
    )) as Record<string, unknown>;
    await this.updateClaimStatusMirror(threadId, result);
    return { threadId, ...this.summarize(result) };
  }

  private summarize(result: Record<string, unknown>) {
    return {
      claimStatus: result["claimStatus"],
      eligible: result["eligible"],
      eligibilityReason: result["eligibilityReason"],
      compensationCents: result["compensationCents"],
      draftText: result["draftText"],
      submission: result["submission"],
      // A plain boolean, not a sentence: this used to return prose under the
      // same `pausedOn` key that get_claim_status returns a NODE NAME under,
      // so one field name carried two incompatible shapes across tool results.
      // What it's waiting for is already derivable from claimStatus.
      awaitingInput: Boolean(result["__interrupt__"]),
      escalationReason: result["escalationReason"],
      payout: result["payout"],
    };
  }
}

/**
 * Turns the real result of executeConfirmedAction into the text actually
 * sent to the user — generated by code from the tool's real return value,
 * never by the LLM, so the confirmation message can't say anything the
 * action didn't actually do. Called only from src/operator/session.ts's
 * deterministic pending-confirmation handling.
 */
export function describeConfirmedActionResult(actionType: ConfirmableActionType, result: unknown): string {
  if (actionType === "forget_my_data") {
    const r = result as {
      disconnectedEmails: { emailAddress: string }[];
      deletedClaimCount: number;
      keptClaims: { count: number; reason: string } | null;
    };
    const parts = ["Done — your data has been deleted."];
    if (r.disconnectedEmails.length > 0) {
      parts.push(`Disconnected: ${r.disconnectedEmails.map((e) => e.emailAddress).join(", ")}.`);
    }
    parts.push(
      `Deleted ${r.deletedClaimCount} claim(s) never sent to an airline, your saved claim details, your chat ` +
        "history, and your consent record.",
    );
    if (r.keptClaims) {
      parts.push(`Kept ${r.keptClaims.count} claim(s): ${r.keptClaims.reason}`);
    }
    return parts.join(" ");
  }

  if (actionType === "disconnect_email") {
    const r = result as { disconnected: boolean; emailAddress?: string; revokedWithProvider?: boolean; note?: string };
    if (!r.disconnected) {
      return "There was nothing connected to disconnect.";
    }
    return (
      `Disconnected ${r.emailAddress}.` +
      (r.revokedWithProvider ? " Authorization was revoked with the provider." : ` ${r.note ?? ""}`)
    );
  }

  return "Done.";
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

interface PassengerProfileToolInput {
  fullName?: string;
  contactEmail?: string;
  phone?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  postalCode?: string;
  countryIsoCode?: string;
  iban?: string;
  bic?: string;
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
