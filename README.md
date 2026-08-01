# PlanPilot

PlanPilot turns messy responsibilities into a realistic, explainable, adjustable schedule. The MVP is deliberately a planning layer—not a chatbot and not a month-calendar clone.

## What works

The local and deployed demo supports this vertical workflow:

0. Clear the seeded demo workspace from any app screen to test the product from an uncluttered state. A browser refresh restores the sample data.
1. Complete onboarding with time zone, waking boundaries, recurring availability, focus-block preferences, and an explicit planning mode.
2. Paste unstructured text or load a TXT file.
3. Extract flexible work, fixed events, finite recurring quotas, and ignored informational statements through a validated provider boundary.
4. Review source-linked tasks and low-confidence fields individually.
5. Edit or approve tasks; unresolved fixed events remain off the schedule.
6. Generate a deterministic proposal around availability, blocked periods, calendar events, waking hours, deadlines, and buffer.
7. Inspect Plan Health, explanations, unscheduled minutes, and actionable options.
8. Lock, reject, request another time for, or approve individual sessions.
9. Export only approved sessions through the idempotent mock calendar provider.
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

- `lib/domain/` is pure TypeScript. It has no React, Supabase, OpenAI, Google, route-handler, or browser dependencies.
- `lib/providers/` contains task-extraction and calendar interfaces plus mock/OpenAI/Google adapters.
- `lib/repositories/` isolates persistence behind `PlanPilotRepository`.
- `app/api/extract/` validates all untrusted input and keeps provider credentials server-side.
- `app/api/calendar/export/` requires an explicit approval literal and exports through the mock provider.
- `supabase/migrations/` contains the PostgreSQL schema, constraints, indexes, triggers, ownership policies, and RLS.
- `tests/` covers dates, extraction validation/repair, deterministic scheduling, replanning, the vertical integration workflow, and migration RLS assumptions.

The app uses the Next.js App Router API and React server components by default; the interactive planning surface is a client component. It is packaged with Vinext for the Sites/Cloudflare runtime.

## Deterministic scheduling rules

The scheduler:

- Generates candidates in stable 15-minute increments.
- Applies hard constraints before scoring: availability, blocked time, calendar events, waking/sleeping boundaries, fixed events, locked sessions, deadlines, weekend rules, min/max session length, and non-overlap.
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

Automatic mode is the default. It prefers Gemini, then OpenAI, when a corresponding server-side API key is configured and otherwise falls back to local deterministic extraction.

### Environment variables

See `.env.example`. In particular:

- `TASK_EXTRACTION_PROVIDER=auto` prefers Gemini, then OpenAI, and otherwise uses local deterministic extraction.
- Set it to `mock`, `gemini`, or `openai` to force a specific provider.
- `GEMINI_MODEL` defaults to `gemini-3.1-flash-lite`.
- `OPENAI_MODEL` defaults to `gpt-5.6-sol`.
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

PlanPilot uses the Responses API with Structured Outputs and validates the result again with Zod. Invalid output receives one repair attempt containing validation errors; a second failure returns a typed recoverable error without discarding the pasted text.

1. Create a project API key.
2. Set `OPENAI_API_KEY` in the server environment.
3. Leave `TASK_EXTRACTION_PROVIDER=auto` or set it to `openai` to require AI extraction.
4. Optionally set `OPENAI_MODEL`; the default is `gpt-5.6-sol`.

The extraction prompt receives the user’s IANA time zone and explicit current local date. Imported content and secrets are never logged by the application.

## Gemini configuration

PlanPilot can use Gemini structured output for responsibility extraction and AI effort estimates.

1. Create a Gemini API key in Google AI Studio.
2. Store it server-side as `GEMINI_API_KEY`.
3. Leave `TASK_EXTRACTION_PROVIDER=auto` or set it to `gemini` to require Gemini.
4. Optionally set `GEMINI_MODEL`; the default is `gemini-3.1-flash-lite`.

Gemini keys remain server-side and are sent only in the API authentication header.

Official references:

- [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)
- [Gemini API key security](https://ai.google.dev/gemini-api/docs/api-key)
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)

Official references:

- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Responses API text generation](https://developers.openai.com/api/docs/guides/text?api-mode=responses)
- [Current model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6)

## Google Calendar production setup

The repository contains a REST-based `GoogleCalendarProvider` with event listing, idempotent insertion, update, and delete methods. The MVP UI intentionally keeps Google disabled until OAuth is configured; the complete approval workflow uses `MockCalendarProvider`.

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

- The default demo state is in-memory and resets on a hard refresh. Supabase repository and migration boundaries are present, but the demo UI is not yet wired to a live authenticated Supabase session.
- OpenAI extraction is implemented but not exercised without the user’s API key; mock extraction is used in tests and the deployed demo.
- Google Calendar provider operations are implemented, while the production OAuth callback/token refresh persistence is documented but deliberately disabled in the UI until credentials exist.
- PDF and image extraction controls are clearly disabled. OCR is not implemented.
- Dragging requests the next valid opening rather than free-form pixel placement; keyboard-accessible “Another time” uses the same validation.
- Recurring availability is normalized to concrete intervals by the demo. A production interval-expansion service is the next persistence integration.

The highest-value next step is wiring authenticated Supabase sessions to the existing repository and schedule-version model, then completing Google OAuth on that durable identity layer.
