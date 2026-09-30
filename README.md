# PlanPilot

Global import instructions: open **Global instructions for this import** to enter filtering, focus, or shared-default rules separately from source documents. For pasted text, opt in to **Treat GLOBAL: lines in my pasted text as my instructions** to recognize one rule per line. Rules are forwarded to AI extraction and verification; imports with explicit rules require AI instead of silently falling back to unfiltered local tasks. Filters apply to the current import, while scheduling rules can update plan availability. See `benchmarks/global-instructions/RESULTS.md` for the initial paired live test (24/24 assertions with either ordinary prose or explicit GLOBAL; no measured accuracy gain on these four cases).

PlanPilot turns messy responsibilities into a realistic, explainable, adjustable schedule. The MVP is deliberately a planning layer—not a chatbot and not a month-calendar clone.

## What works

The local and deployed demo supports this vertical workflow:

0. Clear the workspace from any app screen to test the product from an uncluttered state. Workspace changes are saved to D1 and survive navigation and browser refreshes.
1. Complete onboarding with time zone, waking boundaries, recurring availability, focus-block preferences, and an explicit planning mode.
2. Paste unstructured text or load a TXT file.
3. Extract flexible work, fixed events, finite recurring quotas, and ignored informational statements through a validated provider boundary.
4. Review source-linked tasks and low-confidence fields individually.
5. Edit or approve tasks; unresolved fixed events remain off the schedule.
6. Generate a deterministic proposal around availability, blocked periods, calendar events, waking hours, deadlines, and buffer.
7. Inspect Plan Health, explanations, unscheduled minutes, and actionable options.
8. Lock, reject, request another time for, or approve individual sessions.
9. Download approved sessions as a Google Calendar-compatible `.ics` file.
10. Mark a session missed or partial, review the minimal before/after replan, then apply it.
11. Inspect append-only-style meaningful change history.

Routes:

- `/` product landing page
- `/login`
- `/onboarding`
- `/dashboard`
- `/import`
- `/tasks/review`
- `/schedule`
- `/daily-review`
- `/changes`
- `/settings`

## Architecture

Version 0.1.5 separates AI interpretation from arithmetic. The AI supplies exact source quotes, referenced task IDs, numeric offsets, start/end boundaries, and exact/latest/earliest modes. `quoted-timing.ts` checks source presence, references, and numeric structure without attempting to prove the sentence's meaning using synonyms or grammar. `temporal-derivation.ts` calculates proposed times from grounded anchors and AI-normalized durations. All relationship interpretations and calculated times remain visible and require user review; quote presence does not verify meaning. Unreviewed relationships do not constrain the schedule. Approximate timing stays a preferred proposal, real deadlines remain separate from calculated work windows, and arrival checkpoints appear on the Schedule page without inventing work duration. Invalid quotes, missing anchors, cycles, and contradictory boundaries still require correction. Existing imports need to be reinterpreted to obtain the new relationship data. One-time recurrence exceptions are unchanged.

Run `npx vitest run tests/temporal-derivation.test.ts tests/quoted-timing.test.ts` for arithmetic, quote, review-gating, and scheduling regression checks. With the dev server and Gemini configuration available, `node scripts/temporal-live-check.mjs` exercises real API scenarios without importing tasks into the workspace. Task review shows each relationship interpretation and original quote; hover over a “Calculated” badge for its calculation rationale.

- `lib/domain/` is pure TypeScript. It has no React, Supabase, OpenAI, Google, route-handler, or browser dependencies.
- `lib/providers/` contains task-extraction and calendar interfaces plus mock/OpenAI/Google adapters.
- `lib/repositories/` isolates persistence behind `PlanPilotRepository`.
- `app/api/extract/` validates all untrusted input and keeps provider credentials server-side.
- `app/api/calendar/export/` requires explicit approval and returns an iCalendar download containing only approved sessions.
- `supabase/migrations/` contains the PostgreSQL schema, constraints, indexes, triggers, ownership policies, and RLS.
- `tests/` covers dates, extraction validation/repair, deterministic scheduling, replanning, the vertical integration workflow, and migration RLS assumptions.

The app uses the Next.js App Router API and React server components by default; the interactive planning surface is a client component. It is packaged with Vinext for the Sites/Cloudflare runtime.

## Deterministic scheduling rules

The scheduler:

- Generates candidates in stable 15-minute increments.
- Applies hard constraints before scoring: availability, blocked time, calendar events, waking/sleeping boundaries, fixed events, locked sessions, deadlines, weekend rules, min/max session length, and non-overlap.
- Enforces hard dependency order, minimum gaps, and maximum lags when both responsibilities have resolvable schedule anchors.
- Evaluates the narrow, evidence-safe conditional “longer recurring review when a known exam/test/quiz is the next day.” It changes that occurrence only when an anchored assessment responsibility is actually present; it never creates an exam from the condition itself.
- Ranks tasks from deadline pressure, remaining effort, capacity before the deadline, priority, and energy demand.
- Scores valid slots for urgency, priority, preferred focus/routine windows, energy fit, early completion, recurring spacing, fragmentation, stability, and planning-mode density.
- Uses earlier time as the final stable tie-breaker and never uses randomness.
- Splits long work around preferred/max block sizes without creating a remainder below the minimum session length.
- Adds protected breaks after demanding sessions.
- Preserves 25%, 15%, or 5% capacity in conservative, balanced, or aggressive mode.
- Limits demanding blocks to 2, 3, or 5 per day respectively.
- Returns structured unschedulable reason codes and suggested actions.
- Generates explanations from reason codes without an extra AI call.

Date-only deadlines stay date-only. The user’s sleeping time is used only as a feasibility assumption; it is never saved as a real due time.

## Local setup

Requirements:

- Node.js 22.13 or later
- A Supabase project only for production persistence/authentication
- OpenAI and Google credentials only for their production adapters

```bash
npm install
copy .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

Automatic mode is the default. Imports use Gemini, then OpenAI, when a corresponding server-side API key is configured. Successful AI imports use the hybrid extraction pipeline: the model owns responsibility meaning, while local code preserves table rows, exact source spans, explicit agenda timing, and disagreement diagnostics without rewriting the model's task identity. The live import route fails closed when an explicitly selected AI provider is unavailable or returns invalid structured output; automatic mode uses a reviewed local fallback. Each import is limited to 500 words, the conservative dense-task limit established by the current provider benchmark.

### Environment variables

See `.env.example`. In particular:

- `TASK_EXTRACTION_PROVIDER=auto` prefers Gemini, then OpenAI, based on the configured server-side keys.
- Set it to `gemini` or `openai` to require a specific provider. If it cannot be used, the import returns an explicit error and creates no tasks.
- `GEMINI_MODEL` defaults to the stable `gemini-3.5-flash-lite` model. Gemini 3 sampling parameters are intentionally left at their trained defaults.
- Leave `GEMINI_TEMPERATURE` unset to use Gemini 3's recommended default of `1.0`; set it only for controlled comparisons.
- `GEMINI_THINKING_LEVEL` optionally selects `minimal`, `low`, `medium`, or `high`. Leaving it unset uses the model default (`minimal` for Gemini 3.5 Flash-Lite).
- `GEMINI_LOG_USAGE=1` logs stage-level latency and token counts without logging imported source content or credentials.
- `OPENAI_MODEL` defaults to `gpt-5.6-luna`.
- `OPENAI_EXTRACTION_VERIFY=auto` enables a risk-based second Luna pass that verifies compact drafts containing ambiguity, corrections, relationships, recurrence, tables, low confidence, or other high-risk structure. Set it to `1` to verify every draft or `0` to use one pass. If verification is unavailable, the valid first pass is retained; the API report includes the decision and risk reasons.
- PDF and image imports use a separate transcription step before task extraction. The transcript keeps page labels and unreadable-text warnings; extracted tasks stay in review until you compare them with the browser-local original file. The document reader accepts PDFs and common image formats up to 5 MB and reads at most the first 10 pages.
- Supabase’s anon key may be public; never expose the service-role key.
- Provider refresh tokens must be encrypted with `PROVIDER_TOKEN_ENCRYPTION_SECRET`.

## Supabase

1. Create a Supabase project.
2. Apply `supabase/migrations/202607300001_planpilot_core.sql`.
3. Configure the public URL and anon key.
4. Keep `SUPABASE_SERVICE_ROLE_KEY` server-side and use it only for administrative setup such as the demo seed.
5. Run `npm run seed:demo` if you want the sample account in a configured development project.

The migration uses `auth.users` directly, UUID keys, ownership columns, foreign keys, check constraints, indexes, UTC timestamps, updated-at triggers, and RLS on every user-owned table. `task_history` grants select/insert only to authenticated users so history is append-only through normal application access.

## OpenAI configuration

For the Luna comparison harness, run `npm run eval:luna-two-pass`. It makes three direct Luna calls per fixture: the original one-pass form, a fact ledger, and the form call with that ledger. The intentional cases live in `benchmarks/luna-two-pass/cases.mjs`; results are written under `outputs/` (ignored by git). In the September 15, 2026 nine-case run, the one-pass form scored 266/282 assertions (5/9 complete cases) and the ledger-assisted form scored 278/282 (6/9 complete cases). The remaining misses were a cancellation date, an explicit bench-test duration, and the semantic kind for a recurring flashcard routine, so the second pass is an improvement but still needs review for those edge cases.

The expanded production-contract comparison is documented in `benchmarks/luna-production/LARGE-PROTOCOL.md` and `benchmarks/luna-production/LARGE-RESULTS.md`. On September 19, 2026, the direct full-schema baseline scored 143/158 assertions across 30 original synthetic cases; the compact draft scored 154/158; and the compact draft plus source verifier scored 152/158. The verified path improved over direct by 9 assertions while preserving one valid draft after a verifier failure. This challenge set is evidence of improvement, not a production accuracy guarantee.

PlanPilot uses the Responses API with Structured Outputs and validates the result again with Zod. Invalid output receives one repair attempt containing validation errors; a second failure returns a typed recoverable error without discarding the pasted text.

1. Create a project API key.
2. Set `OPENAI_API_KEY` in the server environment.
3. Leave `TASK_EXTRACTION_PROVIDER=auto` or set it to `openai` to require AI extraction.
4. Optionally set `OPENAI_MODEL`; the default is `gpt-5.6-luna`.
5. Source-grounded verification uses a risk-based second pass by default (`OPENAI_EXTRACTION_VERIFY=auto`) after the first extraction pass. It targets difficult mixed-format inputs while avoiding a second request for short, explicit imports; set it to `1` to verify every draft or `0` for one pass.

The extraction prompt receives the user’s IANA time zone and explicit current local date. Imported content and secrets are never logged by the application.

## Gemini configuration

PlanPilot can use Gemini structured output for responsibility extraction and AI effort estimates.

1. Create a Gemini API key in Google AI Studio.
2. Store it server-side as `GEMINI_API_KEY`.
3. Leave `TASK_EXTRACTION_PROVIDER=auto` or set it to `gemini` to require Gemini.
4. Optionally set `GEMINI_MODEL`; the default is `gemini-3.5-flash-lite`.
5. Optionally set `GEMINI_TEMPERATURE` and `GEMINI_THINKING_LEVEL` for controlled experiments. Production defaults leave both unset.

Gemini keys remain server-side and are sent only in the API authentication header.

Official references:

- [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)
- [Gemini API key security](https://ai.google.dev/gemini-api/docs/api-key)
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)

Official references:

- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Responses API text generation](https://developers.openai.com/api/docs/guides/text?api-mode=responses)
- [Current model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6)

## Export to Google Calendar

1. On **Schedule**, approve the sessions you want to export.
2. Click **Export to Google Calendar** to download `planpilot-schedule.ics`. This includes all approved sessions in the plan, even outside the current schedule view.
3. On a computer, open Google Calendar, go to **Settings → Import & export**, select the file, choose the destination calendar, and click **Import**. See [Google's import instructions](https://support.google.com/calendar/answer/37118).

No Google credentials are needed for file export. The file preserves scheduled start/end instants in UTC, titles, explanations, and a 10-minute display reminder (calendar importers may apply their own notification settings). Recurring responsibilities export only their approved scheduled occurrences. Unapproved, completed, missed, and unscheduled work is excluded.

This is a one-time snapshot, not automatic synchronization. Later edits or deletions in PlanPilot do not update Google Calendar. Event identifiers stay stable for the same session, but file import should not be used as an update/sync mechanism; manage previously imported events in Google Calendar when replacing a schedule.

## Google Calendar direct connection setup

The repository also contains a REST-based `GoogleCalendarProvider` with event listing, idempotent insertion, update, and delete methods. Direct connection and automatic sync still require OAuth integration; the UI uses file export. `MockCalendarProvider` remains available for provider tests.

For production:

1. Create a Google Cloud OAuth web client and enable Calendar API v3.
2. Add the exact HTTPS callback URL for the deployed app.
3. Implement the server callback with CSRF `state`, authorization-code exchange, and offline access.
4. Request the narrowest practical event scopes for the chosen calendar strategy.
5. Encrypt access/refresh tokens with `lib/security/token-encryption.ts` before storing them in `calendar_connections`.
6. Refresh access tokens server-side.
7. Revoke the Google token and clear ciphertext on disconnect.
8. Use the dedicated PlanPilot calendar when the granted scope allows creating an app-owned calendar; otherwise use the selected writable calendar.

The production OAuth callback and refresh-token repository wiring are intentionally not represented as active UI because credentials and a deployed callback origin are required.

Official references:

- [Google OAuth 2.0 for web server apps](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Calendar Events list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
- [Calendar Events insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)

## Validation

```bash
npm run lint
npm run typecheck
npm run test
npm run test:integration
npm run build
```

Or run everything with:

```bash
npm run check
```

Tests never call live OpenAI, Supabase, or Google APIs.

## Deployment

The app builds to a Cloudflare Worker-compatible Vinext bundle and can be deployed with OpenAI Sites. Configure production environment values through the hosting control plane, not `.openai/hosting.json` and not committed files.

For another platform, confirm support for Next App Router route handlers, Node-compatible Web Crypto, and server-only environment variables.

## Known limitations

- Free-form conditional rules remain visible for review but are not executed automatically. The deterministic scheduler only executes the bounded next-day-assessment duration extension described above; new condition/effect families need structured fields and dedicated validation before they can affect a schedule.
- The demo uses one D1-backed owner workspace rather than per-user authenticated workspaces. Supabase repository and migration boundaries are present, but the UI is not yet wired to a live authenticated Supabase session.
- OpenAI extraction is implemented but not exercised without the user’s API key; mock extraction is used in tests and the deployed demo.
- Google Calendar file export is available. Direct provider operations are implemented, while production OAuth callback/token refresh persistence is documented but not connected to the UI.
- PDF and image imports are enabled through a separate transcription step. Screenshots can be selected, dropped, or pasted into the importer; the original stays browser-local and the extracted tasks remain in review until the source is checked. There is no local OCR engine; image transcription uses the configured OpenAI document model.
- Dragging requests the next valid opening rather than free-form pixel placement; keyboard-accessible “Another time” uses the same validation.
- Recurring availability is normalized to concrete intervals by the demo. A production interval-expansion service is the next persistence integration.

The highest-value next step is wiring authenticated Supabase sessions to the existing repository and schedule-version model, then completing Google OAuth on that durable identity layer.
