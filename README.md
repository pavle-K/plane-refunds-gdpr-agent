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
- [Running it](#running-it)
- [Testing](#testing)
- [Project status](#project-status)
- [Legal & compliance disclaimer](#legal--compliance-disclaimer)

---

## How it works

The core of the app is a [LangGraph.js](https://langchain-ai.github.io/langgraphjs/) state graph — a pipeline of nodes with conditional branches and one deliberate loop, checkpointed to Postgres so it can pause for days (waiting on an airline reply) and resume safely across process restarts.

```
ingest → checkEligibility ─(ineligible)──────────────────────────────► END
             │ (eligible)
             ▼
        scoreClaim → draftClaim → humanApproval ─(declined)──────────► END
                                        │ (approved / edited)
                                        ▼
                                   sendClaim → awaitResponse
                                                   │
                              ┌────────────────────┼────────────────────┐
                        (timeout)              (reply: needs_info)  (reply: rejected)
                              ▼                     ▼                    │
                          escalate ──► END     awaitResponse    ┌────────┴────────┐
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
- **`escalate`** — flags for manual/legal follow-up if a rebuttal fails or nothing happens in time.
- **`processPayout`** — triggers the commission split once the airline actually pays.

**The rule that makes this maintainable:** the LLM never computes money or law. Distance bands, delay thresholds, and compensation amounts are pure arithmetic in `src/domain/ec261/`, computed before the LLM is ever called and passed in as fixed values. The LLM is used only for extraction (email → structured data), drafting (structured data → prose), and classification (reply → category) — never for anything a hallucination could turn into a legal or financial error.

### Ways to interact with it

1. **`npm run chat`** — a conversational operator running in your terminal. You talk to it in plain language ("check my inbox for bookings in March", "looks good, send it"); it calls tools that drive the graph above. See [`src/operator/`](src/operator/).
2. **Messaging channels** (`npm run server`) — the same conversation, reachable from Telegram (and, as they're added, Discord/WhatsApp/Viber/Facebook/email) instead of a terminal. See [Connecting messaging channels](#connecting-messaging-channels).
3. **The CLI scripts** (`npm run claim:start`, `claim:resume`, `email:check`) — drive the graph or providers directly with flags, useful for scripted testing without the LLM in the loop for orchestration.

Both (1) and (2) are front doors onto the same underlying conversation logic (`src/operator/session.ts`) — one tool-use loop, one persisted history per user identity, many ways in.

---

## Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript (strict mode) |
| Agent orchestration | LangGraph.js, with a Postgres checkpointer |
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
    airline-directory/ payments/
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
  compliance/      # audit logging (append-only); consent/retention/DSAR are planned, not built yet
  db/              # Drizzle schema, migrations, repositories
  config/          # env parsing (zod, fails fast at boot) and constants
scripts/           # CLI entry points — chat, claim:start/resume, email:connect/check
tests/
  unit/            # mirrors src/ file-for-file
```

See [`CLAUDE.md`](CLAUDE.md) for the full design rationale and the staged build plan this repo follows.

---

## Getting started

### Prerequisites

- Node.js ≥ 20
- A Postgres database (any Postgres 14+ works; the original design target is Neon, EU region, for GDPR data-residency reasons — see `CLAUDE.md` §Stage 0)
- At least one LLM provider's credentials (or a local Ollama server — see below)

### Setup

```bash
npm install
cp .env.example .env
# fill in DATABASE_URL at minimum, plus your chosen LLM provider's key (see below)

npm run db:migrate      # creates the app's own tables (audit log, email connections, channel identities/history)
```

There's no separate command to set up LangGraph's own checkpoint tables — every entry point (`chat`, `claim:start`, `claim:resume`) calls `setupCheckpointer()` on startup, which creates them if missing.

### Environment variables

Everything is validated at boot by `src/config/env.ts` (zod) — the process exits immediately with a clear message if something required is missing or malformed, rather than failing confusingly later.

Only `DATABASE_URL` is unconditionally required. Every provider (flight data, weather, email, payments, and the LLM) falls back to an in-memory fake adapter if its key isn't set, so you can run most of this with nothing but a database configured. See `.env.example` for the full list with explanations.

---

## Choosing an LLM provider

The LLM client lives behind a single interface (`src/agent/llm/llm.port.ts`) with adapters for each provider in `src/agent/llm/providers/`. Switching providers is two lines in `.env` — no code changes:

```bash
LLM_PROVIDER=anthropic     # anthropic | openai | google | xai | openai-compatible
LLM_MODEL=                 # optional — overrides the provider's default model id
```

Only three adapters exist because most providers speak the same wire protocol:

- **`anthropic.adapter.ts`** and **`google.adapter.ts`** — native API integrations for Anthropic and Gemini.
- **`openai-compatible.adapter.ts`** — a single adapter, parameterized by base URL, that covers OpenAI, xAI, and *any* other endpoint implementing OpenAI's Chat Completions format: hosted (OpenRouter, Groq, Together, DeepSeek's own API, ...) or self-hosted (Ollama, vLLM, LM Studio). This is also how every open-weight model plugs in — no per-model code needed.

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

`npm run chat` and every messaging channel are the same conversation underneath — `src/operator/session.ts` is the one place that builds the system prompt, runs the tool-use loop, and persists history (in the `channel_identities`/`conversation_messages` tables, keyed by `(channel, externalId)` — a Telegram chat id, a Discord user id, an email address, whatever a given platform uses as its identity). A channel adapter's only job is translating its platform's payload into `{externalUserId, text}` and sending the reply string back out — see `src/channels/channel.port.ts`.

**Telegram** is the only channel wired up so far (Discord, WhatsApp, Viber, and Facebook follow the same `src/channels/<platform>/` shape once added — `channel.port.ts` and `src/operator/session.ts` don't change).

1. Message [@BotFather](https://t.me/BotFather) on Telegram, run `/newbot`, and copy the token it gives you.
2. Add to `.env`:
   ```bash
   TELEGRAM_BOT_TOKEN=<token from BotFather>
   TELEGRAM_WEBHOOK_SECRET=<any random string>   # e.g. node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```
3. Apply the migration if you haven't: `npm run db:migrate`.
4. Start the API: `npm run server` (listens on `PORT`, default 3000; needs a real `LLM_PROVIDER` configured, same rule as `chat`).
5. Telegram needs to reach that server over public HTTPS. For local development, tunnel it in a separate terminal: `ngrok http 3000` (needs a free ngrok account + `ngrok config add-authtoken <token>` once, from https://dashboard.ngrok.com).
6. Register the webhook:
   ```bash
   npm run telegram:setup
   ```
   This validates `TELEGRAM_BOT_TOKEN` against Telegram, auto-detects the running ngrok tunnel (via ngrok's own local API at `127.0.0.1:4040` — no need to copy the URL by hand), confirms the server actually answers at that URL, then registers the webhook — printing exactly what's missing at whichever step fails, rather than a generic error. For a real hosted deployment (not ngrok), skip auto-detection and pass the real domain: `npm run telegram:setup -- --url https://your-domain.com`.
7. Message your bot on Telegram. Each webhook call is authenticated via the `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET`, acknowledged immediately (Telegram retries on anything but a fast 2xx), and processed asynchronously — the reply goes out via a separate Bot API call, not the webhook response.

If `TELEGRAM_BOT_TOKEN` isn't set, `createTelegramAdapter()` falls back to `FakeChannelAdapter` (records instead of sending) — same convention as every other provider in this repo.

---

## Running it

```bash
npm run chat
```
Talk to it directly: "connect my gmail", "check my inbox for flights in February", "start a claim for BA123 on 2024-06-15", "looks good, send it". This is the real product experience, and it runs on whichever `LLM_PROVIDER` you've configured.

```bash
npm run server
```
Same conversation, reachable from Telegram (and future channels) instead of a terminal — see [Connecting messaging channels](#connecting-messaging-channels).

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
One-time OAuth connection to an inbox, then a sanity check that lists recent messages and flags which look like booking confirmations.

---

## Testing

```bash
npm test           # full suite, once
npm run test:watch # watch mode
npm run typecheck
npm run lint
```

Two hard rules the test suite follows throughout: **no test hits a live API or sends a real email** (every provider has a fake adapter, used everywhere), and **no test makes a real LLM call** (`FakeLlmClient` is used instead — deterministic, queue-based canned responses).

The highest-value tests are in `tests/unit/domain/` — pure functions covering EC261 eligibility, compensation bands (with exact boundary values, since an off-by-one here is a real money bug), and the claim state machine. `tests/unit/agent/nodes/human-approval.node.test.ts` is arguably the most important single test in the project: it asserts the graph genuinely interrupts and that nothing is sent before an explicit human decision comes back.

---

## Project status

Following the staged plan in `CLAUDE.md`:

- ✅ **Stage 0** — project scaffolding, env validation, Postgres + LangGraph checkpointing.
- ✅ **Stage 1** — domain core (`src/domain/`) and all data providers, each with a fake adapter and unit tests.
- ✅ **Stage 2** — the full graph, prompts, the human-approval gate, audit logging, and (beyond the original plan) the conversational chat operator, multi-provider LLM support, and a messaging-channel layer (Telegram wired up; Discord/WhatsApp/Viber/Facebook/email follow the same adapter shape).
- ⬜ **Stage 3** — not started: integration tests across the whole graph, checkpoint/resume durability tests, and most of the compliance layer. `src/compliance/` currently has only append-only audit logging — **no consent capture, retention/purge job, redaction, or DSAR (Article 15/17) export/delete endpoints yet**, and there's no `claim.repo.ts`/`user.repo.ts` — claim state currently lives only in the LangGraph checkpointer, not a queryable table. Note this now also applies to channel identities/history (`channel_identities`, `conversation_messages`) — a WhatsApp phone number or Telegram chat id is PII the moment it's stored, and none of it is covered by DSAR export/delete or retention yet.

---

## Legal & compliance disclaimer

This project handles EU passenger personal data and is designed to eventually move client funds. Per `CLAUDE.md` §6, the following are explicitly **out of scope for engineering** and need to be handled with an accountant/lawyer before this touches a real claim or real money:

- Entity registration, tax treatment, and Stripe Connect's legal/compliance setup.
- Any autonomous send path that bypasses the human-approval node — none exists, and none should be built without a track record first.
- A full GDPR compliance sign-off — the audit log exists, but consent, retention, and data-subject-rights handling do not yet (see [Project status](#project-status)).

Nothing in this codebase constitutes legal advice, and the EC261 rules encoded in `src/domain/ec261/` include documented simplifications in places (see the comments in `constants.ts` and `eligibility.ts`) that should be reviewed before being relied on for a real claim.
