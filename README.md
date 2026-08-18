# Flight Refund Agent

An automated agent that detects EU flight delays/cancellations eligible for compensation under **EC 261/2004**, drafts and files compensation claims on behalf of a passenger, tracks airline correspondence, handles rebuttals to rejected claims, and manages payout via a commission split — with a mandatory human-approval step before anything is ever sent to an airline.

Most eligible passengers never claim the compensation they're owed because the process is tedious and airlines routinely reject valid claims on the first attempt. This project automates detection, evidence-gathering, drafting, and follow-up, while keeping a human in the loop for every outbound action.

> **Status:** active development, not production-ready. See [Project status](#project-status) below for what's actually built vs. planned. This is not legal advice, and nothing here should be relied on for a real claim without review — see [Legal & compliance disclaimer](#legal--compliance-disclaimer).

---

## Contents

- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [Choosing an LLM provider](#choosing-an-llm-provider)
- [Connecting messaging channels](#connecting-messaging-channels)
- [Connecting an email account](#connecting-an-email-account)
- [Running it](#running-it)
- [Testing](#testing)
- [Testing prompts (evals)](#testing-prompts-evals)
- [Project status](#project-status)
- [Legal & compliance disclaimer](#legal--compliance-disclaimer)

---

## How it works

The claim pipeline is a [LangGraph.js](https://langchain-ai.github.io/langgraphjs/) state graph (`src/agent/graph.ts`) — a sequence of nodes with conditional branches and one deliberate loop, checkpointed to Postgres so it can pause for days (waiting on an airline reply) and resume safely across process restarts.

The conversational layer you talk to (`npm run chat`, Telegram) is a separate [LangChain](https://docs.langchain.com/oss/javascript/langchain/overview) `createAgent` (`src/operator/session.ts`), sharing the same Postgres checkpointer. It calls the claim pipeline as one of its tools, alongside 13 others (connecting email, saving passenger details, and so on) — it doesn't duplicate the pipeline's logic. See [Ways to interact with it](#ways-to-interact-with-it) below.

```
ingest → checkEligibility ─(ineligible)──────────────────────────────► END
             │ (eligible)
             ▼
        scoreClaim → draftClaim → humanApproval ─(declined)──────────► END
                                        │ (approved / edited)
                                        ▼
                                   sendClaim → awaitResponse
                                                   │
                        ┌─────────────────┬────────┴────────┬────────────────────┐
                  (timeout)      (reply: needs_info)  (reply: ambiguous)   (reply: rejected)
                        ▼                 ▼                  ▼                    │
                    escalate ──► END  awaitResponse       escalate ──► END ┌───────┴────────┐
                                                                       (evidence)      (no evidence)
                                                                            ▼                 ▼
                                                                          rebut          escalate ──► END
                                                                            │
                                                                            └──► draftClaim (loop back)

                                          (reply: accepted)
                                                ▼
                                          processPayout ──► END
```

- **`ingest`** — parses booking data (uploaded confirmation or a connected inbox).
- **`checkEligibility`** — cross-references flight status and delay cause against EC261 rules. Ineligible claims stop here and never reach the LLM.
- **`scoreClaim`** — an LLM estimates likelihood of success (delay length, stated cause, evidence quality) — never decides eligibility or the compensation amount, only informs a rebuttal/escalation decision later.
- **`draftClaim`** — an LLM drafts the claim letter from structured facts computed elsewhere. It is never given the freedom to state a number or a fact you didn't hand it.
- **`humanApproval`** — a real `interrupt()`: the graph pauses here and will not proceed without an explicit approve/edit/decline decision from a person. Enforced a second time, independently, inside `sendClaim` as defense in depth.
- **`sendClaim` → `awaitResponse`** — dispatches the email, then waits — genuinely, for days or weeks if needed, durable across restarts because of the Postgres checkpointer.
- **`classifyResponse`** — an LLM categorizes the airline's reply: accepted / rejected / needs-info / ambiguous.
- **`rebut`** — loops back to `draftClaim` with counter-evidence if rejected and the evidence supports pushing back. Bounded (`MAX_REBUTTAL_ATTEMPTS`) so it can't cycle forever.
- **`escalate`** — flags for manual/legal follow-up if the reply is ambiguous, a rebuttal fails, or nothing happens in time.
- **`processPayout`** — triggers the commission split once the airline actually pays.

**The rule that makes this maintainable:** the LLM never computes money or law. Distance bands, delay thresholds, and compensation amounts are pure arithmetic in `src/domain/ec261/`, computed before the LLM is ever called and passed in as fixed values. The LLM is used only for extraction (email → structured data), drafting (structured data → prose), and classification (reply → category) — never for anything a hallucination could turn into a legal or financial error.

### Ways to interact with it

1. **`npm run chat`** — a conversational operator running in your terminal. You talk to it in plain language ("check my inbox for bookings in March", "looks good, send it"); it calls tools that drive the graph above. See [`src/operator/`](src/operator/).
2. **Telegram** (`npm run server`) — the same conversation, reachable from a Telegram bot instead of a terminal. Telegram is the only messaging channel actually wired up right now — the adapter shape supports adding others (Discord, WhatsApp, ...) later, but none exist yet. See [Connecting messaging channels](#connecting-messaging-channels).
3. **The CLI scripts** (`npm run claim:start`, `claim:resume`, `email:check`) — drive the claim-pipeline graph or a provider directly with flags, bypassing the conversational layer entirely. Useful for testing the pipeline itself without an LLM in the loop.

(1) and (2) are two front doors onto the same underlying conversation logic (`src/operator/session.ts`) — one `createAgent` agent, one identity per user, many ways in.

Connecting an email account requires `npm run server` to be running, even when using `npm run chat`. The `connect_email` tool initiates an OAuth flow, and the redirect target is served by the API server, not the chat process. See [Connecting an email account](#connecting-an-email-account).

---

## Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript (strict mode) |
| Claim pipeline | LangGraph.js `StateGraph`, with a Postgres checkpointer |
| Conversational agent | LangChain `createAgent`, on the same Postgres checkpointer |
| Backend runtime | Node.js ≥ 20 |
| Database | Postgres (Drizzle ORM + migrations) |
| LLM | Multi-provider — Anthropic, OpenAI, Google, xAI, or any OpenAI-compatible endpoint (hosted or self-hosted) — see below |
| Email in | Gmail / Outlook OAuth, read-only narrow scope |
| Email out | Postmark |
| Payments | Stripe Connect |
| Flight data | AeroAPI |
| Weather | IEM ASOS (free, keyless METAR archive) |
| Testing | Vitest |

---

## Repository layout

```
src/
  domain/          # PURE business/legal logic. No I/O, no LLM, no clock.
    ec261/         #   eligibility, compensation amounts, distance, "extraordinary circumstances"
    claim/         #   claim types, state machine, deadlines
    money/         #   commission split math
  providers/       # ALL external I/O, behind interfaces (ports/adapters). Every
                   #   provider has a fake adapter used in every test — nothing
                   #   in the test suite hits a live API or sends a real email.
    flight-status/ weather/ disruption/ email-ingest/ email-send/
    airline-directory/ airport-reference/ payments/
  agent/
    graph.ts       # node/edge wiring only — no business logic
    state.ts       # LangGraph state channels
    nodes/         # one thin file per pipeline node
    prompts/       # prompts as data (.md files), never inlined in code
    llm/           # the multi-provider LLM client — see below
  operator/        # tools.ts + prompt.md (what the agent can do) and
                   #   session.ts (the shared conversation loop every channel calls)
  channels/        # messaging-platform adapters, same ports/adapters shape as providers/
    telegram/      #   webhook parsing + Bot API sendMessage; fake.adapter.ts covers the rest for now
  api/
    server.ts      # hosts inbound channel webhooks
    routes/channels/  # one route file per platform
  compliance/      # audit logging (append-only) and first-contact consent capture;
                   #   retention/redaction/DSAR are planned, not built yet
  db/              # Drizzle schema, migrations, repositories
  config/          # env parsing (zod, fails fast at boot) and constants
scripts/           # CLI entry points — chat, claim:start/resume, email:connect/check
tests/
  unit/            # mirrors src/ file-for-file
  evals/           # prompt regression suite (npm run test:prompts) — calls a REAL LLM,
                   #   deliberately excluded from `npm test` / CI, see Testing prompts below
```

---

## Getting started

### Prerequisites

- Node.js ≥ 20
- A Postgres database (any Postgres 14+ works; the original design target is Neon, EU region, for GDPR data-residency reasons)
- At least one LLM provider's credentials (or a local Ollama server — see below)

### Setup

```bash
npm install
cp .env.example .env
# fill in DATABASE_URL at minimum, plus your chosen LLM provider's key (see below)

npm run db:migrate      # creates the app's own tables (users, channel identities/history,
                         # consents, email connections, claim ownership, audit log)
```

There's no separate command to set up LangGraph's own checkpoint tables — every entry point (`chat`, `claim:start`, `claim:resume`) calls `setupCheckpointer()` on startup, which creates them if missing.

### Environment variables

Everything is validated at boot by `src/config/env.ts` (zod) — the process exits immediately with a clear message if something required is missing or malformed, rather than failing confusingly later.

Only `DATABASE_URL` is unconditionally required. Every provider (flight data, weather, email, payments, and the LLM) falls back to an in-memory fake adapter if its key isn't set, so you can run most of this with nothing but a database configured. See `.env.example` for the full list with explanations.

`NODE_ENV=production` additionally **requires** `TELEGRAM_WEBHOOK_SECRET`, `PUBLIC_URL`, and `TOKEN_ENCRYPTION_KEY` — boot fails immediately, naming every one that's missing, rather than discovering the gap at request time (e.g. an unauthenticated webhook, or a broken OAuth link).

---

## Choosing an LLM provider

Model selection is a single factory function (`src/agent/llm/chat-model.ts`) that returns a LangChain chat model. Switching providers is two lines in `.env` — no code changes:

```bash
LLM_PROVIDER=anthropic     # anthropic | openai | google | xai | openai-compatible
LLM_MODEL=                 # optional — overrides the provider's default model id
```

Three LangChain model classes cover every provider, because most of them speak the same wire protocol:

- **`ChatAnthropic`** and **`ChatGoogleGenerativeAI`** — native integrations for Anthropic and Gemini.
- **`ChatOpenAI`**, parameterized by base URL — covers OpenAI, xAI, and *any* other endpoint implementing OpenAI's Chat Completions format: hosted (OpenRouter, Groq, Together, DeepSeek's own API, ...) or self-hosted (Ollama, vLLM, LM Studio). This is also how every open-weight model plugs in — no per-model code needed.

### Running a free, open-weight model locally

Self-hosting means passenger PII in your prompts never leaves your machine — no third-party LLM processor, no DPA question for that hop, unlike calling any hosted API. The tradeoff is speed and hardware requirements (see the note below).

```bash
brew install ollama          # or: brew install --cask ollama, for the menu-bar app
ollama serve                 # skip if you installed the cask app — it runs this for you
ollama pull qwen3:8b
```

`.env`:
```bash
LLM_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1
OPENAI_COMPATIBLE_MODEL=qwen3:8b
OPENAI_COMPATIBLE_API_KEY=      # unused by Ollama, leave blank
```

**Hardware note:** local inference is genuinely demanding. As a rough rule of thumb, a 4-bit quantized model needs about `params × 0.6GB` of RAM (so Qwen3-8B needs ~5GB free, on top of whatever the OS and other apps are using), and sustained generation is one of the heavier workloads a laptop can run — expect real heat and battery drain, and expect it to be considerably slower than a cloud API, especially on a fanless machine (e.g. a MacBook Air), which throttles under sustained load. Keep the machine plugged in if you're testing this for real. If you want more headroom, an MLX build (`mlx-community` on Hugging Face) is typically faster than Ollama's default backend specifically on Apple Silicon.

**One current limitation:** `npm run chat` requires the configured provider to actually be reachable — it refuses to start against the fake fallback, since a chat session needs a real model to talk to.

---

## Connecting messaging channels

`npm run chat` and Telegram are the same conversation underneath — `src/operator/session.ts` is the one place that builds the system prompt and runs the agent, keyed by `(channel, externalId)`, e.g. a Telegram chat id. The agent's own conversation memory lives in its LangGraph checkpointer thread, one per identity; `channel_identities`/`conversation_messages` (Postgres) separately hold the identity record and a full compliance/audit transcript of every turn, including ones the agent never runs on (e.g. blocked by the consent gate). A channel adapter's only job is translating its platform's payload into `{externalUserId, text}` and sending the reply string back out — see `src/channels/channel.port.ts`.

Telegram is the only channel wired up right now. The adapter shape (`src/channels/<platform>/`) is built so others (Discord, WhatsApp, Viber, Facebook, email) can slot in later without touching `channel.port.ts` or `src/operator/session.ts`, but none of those exist yet.

### Setting up the Telegram bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram, run `/newbot`, and copy the token it gives you.
2. Add to `.env`:
   ```bash
   TELEGRAM_BOT_TOKEN=<token from BotFather>
   TELEGRAM_WEBHOOK_SECRET=<any random string>   # e.g. node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```
3. Apply the migration if you haven't: `npm run db:migrate`.

**Shortcut — one command instead of steps 4–6:**
```bash
npm run dev:telegram
```
Starts ngrok (or reuses one already running), starts the server with `PUBLIC_URL` set to the tunnel automatically, registers the Telegram webhook against it, and prints the two things that genuinely can't be scripted — the redirect URI to add in Google Cloud Console / Azure, and the Google "Testing" mode test-user reminder (see [Connecting an email account](#connecting-an-email-account) — you'll need that too if you want the bot to connect a real inbox). Needs a free ngrok account + `ngrok config add-authtoken <token>` once, from https://dashboard.ngrok.com. `Ctrl+C` stops the server and tunnel together, cleanly.

<details>
<summary>What it's doing (the manual version, if you want separate terminals, or a real hosted deployment instead of ngrok)</summary>

4. Start the API: `npm run server` (listens on `PORT`, default 3000; needs a real `LLM_PROVIDER` configured, same rule as `chat`).
5. Telegram needs to reach that server over public HTTPS. For local development, tunnel it in a separate terminal: `ngrok http 3000`.
6. Register the webhook:
   ```bash
   npm run telegram:setup
   ```
   This validates `TELEGRAM_BOT_TOKEN` against Telegram, auto-detects the running ngrok tunnel (via ngrok's own local API at `127.0.0.1:4040` — no need to copy the URL by hand), confirms the server actually answers at that URL, then registers the webhook — printing exactly what's missing at whichever step fails, rather than a generic error. For a real hosted deployment (not ngrok), skip auto-detection and pass the real domain: `npm run telegram:setup -- --url https://your-domain.com`.

</details>
7. Message your bot on Telegram. Each webhook call is authenticated via the `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET`, acknowledged immediately (Telegram retries on anything but a fast 2xx), and processed asynchronously — the reply goes out via a separate Bot API call, not the webhook response.

If `TELEGRAM_BOT_TOKEN` isn't set, `createTelegramAdapter()` falls back to `FakeChannelAdapter` (records instead of sending) — same convention as every other provider in this repo.

---

## Connecting an email account

The `connect_email` tool always uses a real OAuth flow. The redirect callback is served by the API server's OAuth route (`src/api/routes/oauth.routes.ts`), which only runs as part of `npm run server` — regardless of which front door initiated the connection:

- **`npm run chat` alone:** `npm run server` must also be running, in a second terminal, with `PUBLIC_URL` set to match (`http://localhost:3000` by default, matching `PORT`). Without it, the OAuth redirect has no listener to reach.
- **Telegram:** no extra step required — `npm run server` is already running to serve the bot.

For local CLI testing without a second process, use the local-loopback flow instead:
```bash
npm run email:connect -- gmail     # or: outlook
npm run email:check
```
This is a separate flow (`scripts/connect-email.ts`) that opens the browser and blocks in-process until the redirect completes, followed by a check that lists recent messages and flags likely booking confirmations. It only connects the local CLI identity, and is distinct from the `connect_email` tool used inside a live conversation.

### How a remote user connects their own inbox

Every user who messages the bot — on Telegram or any future channel — gets their own identity, their own consent record, their own email connection, and their own claims, fully isolated from every other user's (see `src/db/schema.ts`'s `users` / `channel_identities` / `email_connections` / `claims` tables, and `src/operator/tools.ts`'s per-user authorization checks). Nothing here assumes a single developer using their own accounts.

1. **First contact.** The first message from a new (channel, externalId) pair gets a fixed data-use notice — not LLM-generated, deliberately, same reasoning as the human-approval gate — describing what's collected and why, and requires an explicit "yes" (or similar) before anything else happens. See `src/compliance/consent.ts`. **The notice text is a placeholder** — it needs a real privacy policy link and company/DPO contact details before this reaches real users (see [Legal & compliance disclaimer](#legal--compliance-disclaimer)).
2. **Connecting email.** The user says something like "connect my gmail." The bot replies with a link immediately — it does not block waiting for them to finish it. The user opens the link in their own browser, authorizes on Google's/Microsoft's real consent screen, and lands on a minimal confirmation page. The bot then sends a proactive "Connected" message back into the same chat on its own — no polling, no second message needed from the user.
3. **Ownership.** If a mailbox that's already connected to one user gets reconnected by a different user (who just proved control of it via a real, completed OAuth flow), ownership reassigns to them, and the change is written to the audit log (`entryType: "mailbox_reassigned"`).

Requires `PUBLIC_URL` (the public HTTPS origin this server is reachable at, no trailing slash). Manual, one-time prerequisites before this works for real (non-developer) users over Telegram — not code:

- Register `${PUBLIC_URL}/oauth/gmail/callback` and `${PUBLIC_URL}/oauth/outlook/callback` as authorized redirect URIs in Google Cloud Console / Azure (separate from the localhost URI the CLI's local-loopback flow above uses).
- Move the Google OAuth consent screen out of "Testing" mode — `gmail.readonly` is a sensitive scope, and Google requires an app verification review before real third-party users (not just your own account) can complete it. This can take real review time — start it early.

---

## Running it

```bash
npm run chat
```
Talk to it directly: "check my inbox for flights in February", "start a claim for BA123 on 2024-06-15", "looks good, send it". This is the real product experience, and it runs on whichever `LLM_PROVIDER` you've configured. If you also want to say "connect my gmail" here, start `npm run server` in a second terminal first — see [Connecting an email account](#connecting-an-email-account).

```bash
npm run server
```
Same conversation, reachable from Telegram instead of a terminal — see [Connecting messaging channels](#connecting-messaging-channels).

```bash
npm run claim:start -- --flight BA123 --date 2024-06-15 --from LHR --to JFK --carrier BA --delay 220 --status delayed
```
Drives a single claim through the graph directly via flags, without the chat layer in front. Useful for testing the pipeline itself. If `FLIGHT_DATA_API_KEY` isn't set, it seeds a synthetic flight-status result from `--delay`/`--status` instead of hitting AeroAPI — with a real key set, those flags are ignored in favor of the actual flight's real status (and a flight number/date too far in the past will be rejected by AeroAPI, which only looks back ~10 days).

```bash
npm run claim:resume -- --thread claim-1234567890
```
Resumes a paused claim (e.g. once you have a real airline reply to paste in) — the thread id is printed by `claim:start`.

```bash
npm run email:connect -- gmail     # or: outlook
npm run email:check
```
One-time OAuth connection to an inbox for the local CLI identity, then a sanity check that lists recent messages and flags which look like booking confirmations. See [Connecting an email account](#connecting-an-email-account) for how this differs from `connect_email` inside a live conversation.

---

## Testing

```bash
npm test           # full suite, once
npm run test:watch # watch mode
npm run typecheck
npm run lint
```

Two hard rules the test suite follows throughout: **no test hits a live API or sends a real email** (every provider has a fake adapter, used everywhere), and **no test makes a real LLM call** (`FakeChatModel` is used instead — a deterministic, queue-based LangChain chat model).

The highest-value tests are in `tests/unit/domain/` — pure functions covering EC261 eligibility, compensation bands (with exact boundary values, since an off-by-one here is a real money bug), and the claim state machine. `tests/unit/agent/nodes/human-approval.node.test.ts` is arguably the most important single test in the project: it asserts the graph genuinely interrupts and that nothing is sent before an explicit human decision comes back.

---

## Testing prompts (evals)

`npm test` never makes a real LLM call (see [Testing](#testing) above) — so it can't answer
the question that actually matters for `src/operator/prompt.md`: **does the model reliably
call the right tool?** That's a separate suite, `tests/evals/`, built after a real incident
where the operator fabricated an entire fake data-deletion flow instead of calling
`forget_my_data` — and where a single-turn chat transcript alone wasn't enough to prove
whether the tool had been called at all.

```bash
npm run test:prompts
```

Runs every case in `tests/evals/cases/` against `src/operator/prompt.md` and your
configured `LLM_PROVIDER`, 3 trials each by default. This costs real API calls and is
non-deterministic by nature (the same case can pass on one trial and fail on the next —
that variance *is* the signal), so it's **never run in CI** — `vitest.config.ts`'s
`include` is scoped to `tests/unit/` and `tests/integration/` only, and `tests/evals/`
falls outside it on purpose. You run this by hand, whenever you want to check.

**What actually gets sent to the model.** One case = one realistic turn: the *entire*
system prompt (whichever file you're testing, with the same "Current date and time"
suffix the real bot appends), the *entire* real 14-tool list from
`src/operator/tools.ts` (never narrowed down to "just the tool being tested"), and the
case's message. If the model calls a tool, the call is intercepted — recorded, then
handed back a plausible fake result — so nothing ever touches real Postgres, sends a
real email, or starts a real deletion. The case's `assert()` then scores what actually
got called.

**Flags:**

```bash
npm run test:prompts -- --trials 5                      # more trials than the default 3
npm run test:prompts -- --cases forget-my-data.single-turn,approval-gate.explicit-approval-is-honoured
npm run test:prompts -- --prompt path/to/candidate.md    # test a candidate file instead of the live one
npm run test:prompts -- --compare old.md new.md          # run both, print them side by side
```

**Coverage is only what's been written as a case — not automatic.** Right now
`tests/evals/cases/` covers `forget_my_data`, `submit_approval_decision`, and
`start_claim`; the other tools have none. To add coverage for a tool, drop a new file in
`tests/evals/cases/` following the existing ones' shape and list its exported array in
`tests/evals/cases/index.ts`:

```ts
{
  id: "disconnect-email.question-is-not-a-request",
  description: "A privacy question must not be read as a disconnect request.",
  message: "what happens if I disconnect my email?",
  assert: assertions.neverCalled("disconnect_email"),
}
```

**Langfuse (optional).** Set `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` in `.env` and two
things happen automatically, no flags needed: every real operator turn (`npm run chat`,
`npm run server`) gets traced — one trace per turn, the LLM call as a `generation`, each
tool dispatch as a `span` — and every eval run gets pushed to Langfuse's Dataset feature
under a named run (auto-generated, or `--langfuse-run <name>`), so two runs (e.g. before
and after a prompt rewrite) can be compared side by side in Langfuse's own UI, not just in
this script's console table. Unset, both silently no-op — same "falls back when
unconfigured" convention as every other provider in this repo. `LANGFUSE_HOST` defaults
to Langfuse Cloud's **EU region**: this project keeps its Postgres in Frankfurt
specifically for EU data residency, and a trace can carry a full raw prompt — which
includes passenger PII pulled from a real conversation — so the same reasoning applies
here.

---

## Project status

### Built and tested

- Environment/config validation and Postgres + LangGraph checkpointing, working end to end.
- The EC261 domain core (`src/domain/`) and every data provider, each with a fake adapter and unit tests.
- The claim-pipeline graph, prompts, the human-approval gate, and audit logging.
- The conversational operator (LangChain `createAgent`, sharing the claim pipeline's Postgres checkpointer), multi-provider LLM support (Anthropic, OpenAI, Google, xAI, or any OpenAI-compatible endpoint), and a Telegram messaging channel.
- Multi-tenant identity and access: a `users` model separate from `channel_identities`, per-user `email_connections` with a non-blocking hosted OAuth flow (PKCE) and real-OAuth-verified reassignment on reconnect, per-user authorization on every claim-touching tool (`src/operator/tools.ts`), first-contact consent capture, and no in-process state — any instance can handle any request.

### Not built yet

- **Compliance.** No retention/purge job, no log redaction, no DSAR (Article 15/17) export/delete endpoints. Audit logging and first-contact consent capture exist, but the consent notice text itself is a **placeholder**, not reviewed legal copy (see [Legal & compliance disclaimer](#legal--compliance-disclaimer)). A Telegram chat id or a future WhatsApp phone number is personal data the moment it's stored, and none of it is covered by retention or DSAR yet.
- **Integration and durability testing.** No full-lifecycle tests across the whole graph, and no checkpoint/resume durability tests against real Postgres.
- **A frontend.** Everything today is chat-driven (CLI or Telegram) or scripted through the CLI tools — there's no web UI for approvals, claim tracking, or DSAR requests.
- **Self-updating airline data.** `src/providers/airline-directory/data/airlines.json` is a static, manually maintained file — nothing refreshes or verifies claims-contact addresses over time.
- **Automated web-form claim submission.** Some airlines (Ryanair among them) don't accept claims by email at all — only through their own web form. Today that's a manual handoff: the system hands a human the drafted letter, the form URL, and the fields it knows are required. Driving the form submission itself — mapping fields, detecting when an airline's form layout changes, and never guessing at a field it can't confidently identify — is proposed but not built; see [issue #8](https://github.com/pavle-K/plane-refunds-gdpr-agent/issues/8).
- **Rate-limit handling.** A real provider 429 isn't yet translated into a user-facing message for the LangChain model layer.
- Claim state itself still lives only in the LangGraph checkpointer — `claims` (added for ownership/authorization) is a thin id+status mirror, not the full claim record.

---

## Legal & compliance disclaimer

This project handles EU passenger personal data and is designed to eventually move client funds. The following are explicitly **out of scope for engineering** and need to be handled with an accountant/lawyer before this touches a real claim or real money:

- Entity registration, tax treatment, and Stripe Connect's legal/compliance setup.
- Any autonomous send path that bypasses the human-approval node — none exists, and none should be built without a track record first.
- A full GDPR compliance sign-off — the audit log and first-contact consent capture exist, but the consent notice (`src/compliance/consent.ts`'s `CONSENT_NOTICE`) is a **placeholder** with no real privacy policy link or company/DPO contact details, and retention, redaction, and data-subject-rights (DSAR) handling don't exist yet (see [Project status](#project-status)). Don't point real users at this until that notice is replaced with reviewed legal copy.

Nothing in this codebase constitutes legal advice, and the EC261 rules encoded in `src/domain/ec261/` include documented simplifications in places (see the comments in `constants.ts` and `eligibility.ts`) that should be reviewed before being relied on for a real claim.
