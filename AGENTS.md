# AGENTS.md

This file applies to the entire repository.

## Product contract

Eventernote Autofill turns one public event URL into one or more reviewable Eventernote records. It must never write externally without an explicit user confirmation. Keep the following behavior stable:

- Review state and selected upload files live only in the browser. After delivering an analysis result, the API must not retain editable review data or confirmation tokens.
- Keep `EVENTERNOTE_WRITE_ENABLED=false` as the safe default.
- Keep Eventernote, OpenAI, and deployment credentials on the server. Never expose them through Vite variables, API responses, logs, fixtures, or committed Compose values.
- Use descriptions only when a submitted or discovered source directly provides one. Do not generate, summarize, or translate a missing description.
- Preserve source and manual values. Infer opening and ending times only when missing, and label inferred evidence as low confidence.
- Match Eventernote entities automatically only at high confidence. The editor must retain an explicit existing/new entity override.
- Treat source URLs, redirects, linked pages, and remote images as untrusted. All remote fetches must continue through the safe-fetch boundary.

## Repository map

- `src/`: React/Vite review interface.
- `server/`: Stateless Node HTTP API for extraction, submission checks, and Eventernote integration. Only active analysis progress is kept in memory.
- `shared/`: types and utilities used by both browser and server builds.
- `Dockerfile`: production build and non-root runtime image.
- `docker-compose.yml`: Portainer stack definition using the published GHCR image.
- `.github/workflows/docker-publish.yml`: validation, image publication, and authenticated Portainer Git-stack redeploy after pushes to `main`.

The production server serves the built frontend and API from port `8790`. `GET /health` must remain unauthenticated for container and deployment health checks.

## Development workflow

Use Node.js 22 and the committed lockfile.

```powershell
npm ci
npm run lint
npm run test
npm run build
docker compose config --quiet
docker build -t eventernote-autofill:local .
```

For local development, load environment values from an untracked `.env.local` and run `npm run dev`. The Vite UI and API listen on ports `5173` and `8790` respectively.

Add focused Vitest coverage for parser, source selection, time inference, network-safety, and integration contract changes. Treat lint, tests, TypeScript/Vite build, Compose validation, and a live container health check as separate validation surfaces.

## Implementation rules

- Prefer existing modules and data types over parallel abstractions.
- Validate all API inputs with Zod and keep request-size limits explicit.
- Keep error messages actionable without including credentials, authorization headers, upstream response bodies that may contain private data, or complete Portainer stack payloads.
- Preserve Eventernote confirmation-form steps and hidden fields, restrict form submissions to the configured Eventernote origin, and log submission failures only as redacted structured metadata.
- Send Eventernote date parts as decimal integers, preserve two-digit time parts, and normalize flattened confirmation-page times to `HH:MM` before the final POST.
- Map known Eventernote event fields by their exact parameter names before using any label-context fallback.
- On an Eventernote `/add/complete` response, prefer canonical metadata or the unique same-name entity link; for actors and places only, recover a missing target link from one unique exact-name search result so successful writes remain idempotent despite unrelated footer links.
- Download selected images through the safe-fetch boundary, convert them to JPEG in an isolated OS temporary directory, upload only the JPEG bytes, and remove the temporary directory after success or failure.
- For every newly created actor, have the server-side AI supply a hiragana reading, comma-separated search aliases, and Eventernote sex code before any external write; submit them as exact `kana`, `keyword`, and `sex` fields without asking the user to fill them.
- Maintain idempotent retries after partial Eventernote progress by returning accepted IDs to the browser with every submission result.
- Do not broaden allowed outbound hosts, ports, content types, sizes, or redirect behavior without security tests.
- Keep user-visible Traditional Chinese text consistent with the existing interface. Keep code, configuration keys, and developer documentation in English.

## Deployment rules

- Production images are `ghcr.io/kitsunezu/eventernote-autofill:latest` plus immutable `sha-*` tags.
- Portainer owns runtime secrets.
- Never commit real values for `APP_TOKEN`, `OPENAI_API_KEY`, `EVENTERNOTE_USERNAME`, `EVENTERNOTE_PASSWORD`, or deployment service tokens.
- A commit or successful image build is not proof of deployment. Verify the Actions publish job, Portainer stack update/container recreation, and the running container's `/health` response independently.
- Portainer Git redeploy requests must preserve the stack's existing `Env`; omitting it can clear saved environment variables before Compose interpolation.
- The redeploy job uses `PORTAINER_API_KEY` plus the Cloudflare Access service-token secrets `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`.

## Overview

Summarize the repository purpose and the agent-facing context future contributors should know.

## Project Context

Document core architecture, project purpose, and important implementation context here.

<!-- commit-and-push-with-agents:context:start -->
### Latest Project Context Signals

- Last scan: `2026-08-08`.
- Review `server/ai.test.ts` for architecture or project-context updates.
- Review `server/ai.ts` for architecture or project-context updates.
- Review `server/api-client.test.ts` for architecture or project-context updates.
- Review `server/eventernote.test.ts` for architecture or project-context updates.
- Review `server/eventernote.ts` for architecture or project-context updates.
- Review `server/index.ts` for architecture or project-context updates.
- Review `server/parser.ts` for architecture or project-context updates.
- Review `server/submission-readiness.test.ts` for architecture or project-context updates.
- Review `src/App.tsx` for architecture or project-context updates.
<!-- commit-and-push-with-agents:context:end -->
## Available Features

Document user-facing or agent-facing features here as they are added or changed.

<!-- commit-and-push-with-agents:features:start -->
### Latest Feature Signals

- Last scan: `2026-08-08`.
- Review `server/ai.test.ts` for user-facing or agent-facing feature updates.
- Review `server/ai.ts` for user-facing or agent-facing feature updates.
- Review `server/api-client.test.ts` for user-facing or agent-facing feature updates.
- Review `server/eventernote.test.ts` for user-facing or agent-facing feature updates.
- Review `server/eventernote.ts` for user-facing or agent-facing feature updates.
- Review `server/index.ts` for user-facing or agent-facing feature updates.
- Review `server/parser.ts` for user-facing or agent-facing feature updates.
- Review `server/submission-readiness.test.ts` for user-facing or agent-facing feature updates.
- Review `src/App.tsx` for user-facing or agent-facing feature updates.
<!-- commit-and-push-with-agents:features:end -->
## Common Commands

Document build, test, lint, run, and release commands here.

<!-- commit-and-push-with-agents:commands:start -->
### Latest Command Signals

- Last scan: `2026-08-08`.
- No command path signal was detected; verify manually from `git diff`.
<!-- commit-and-push-with-agents:commands:end -->
## Dependencies & Development Environment

Document dependency managers, runtime versions, setup steps, and development environment assumptions here.

<!-- commit-and-push-with-agents:environment:start -->
### Latest Dependency and Environment Signals

- Last scan: `2026-08-08`.
- Dependency files: no direct path signal detected.
- Development environment files: no direct path signal detected.
<!-- commit-and-push-with-agents:environment:end -->
## Active Agents

No active agents have been documented yet.

<!-- commit-and-push-with-agents:active:start -->
### Recently Touched Agent Definitions

- Last scan: `2026-08-08`.
- No explicit agent definitions were inferred from the latest change set.
<!-- commit-and-push-with-agents:active:end -->
## Agent Capabilities & Tools

Document agent capabilities, tools, prompts, skills, and workflows here.

<!-- commit-and-push-with-agents:capabilities:start -->
### Latest Agent-Related Change Signals

- Last scan: `2026-08-08`.
- No prompt, tool, skill, workflow, model, or agent files were detected by path heuristics.
<!-- commit-and-push-with-agents:capabilities:end -->
## Recent Changes

### 2026-08-08 - Recovered actor IDs from completion pages

- Actor and place completion handling now ignores unrelated same-entity footer links and prefers the link whose text exactly matches the submitted name.
- When the completion page omits its target link, one unique exact-name actor/place search result can safely recover the accepted ID instead of misreporting a successful write as failed.
- Regression coverage includes both noisy completion pages and link-free actor completion pages.

### 2026-08-08 - Recorded repository changes

- Branch: `main`
- Affected files: 11 detected before updating `AGENTS.md`.
- Change types: modified: 11.
- Agent-related files: none detected by path heuristics.
- Core impact assessment:
  - Core Architecture: review/update required (`server/ai.test.ts`, `server/ai.ts`, `server/api-client.test.ts`, `server/eventernote.test.ts`, `server/eventernote.ts` and 4 more).
  - Available Features: review/update required (`server/ai.test.ts`, `server/ai.ts`, `server/api-client.test.ts`, `server/eventernote.test.ts`, `server/eventernote.ts` and 4 more).
  - Common Commands: no direct path signal detected.
  - Dependencies: no direct path signal detected.
  - Environment: no direct path signal detected.
  - Agent System: no direct path signal detected.
- Files:
  - `GENTS.md` (modified)
  - `server/ai.test.ts` (modified)
  - `server/ai.ts` (modified)
  - `server/api-client.test.ts` (modified)
  - `server/eventernote.test.ts` (modified)
  - `server/eventernote.ts` (modified)
  - `server/index.ts` (modified)
  - `server/parser.ts` (modified)
  - `server/submission-readiness.test.ts` (modified)
  - `shared/types.ts` (modified)
  - `src/App.tsx` (modified)

### 2026-08-08 - Recorded repository changes

- Branch: `main`
- Affected files: 6 detected before updating `AGENTS.md`.
- Change types: modified: 4, untracked: 2.
- Agent-related files: none detected by path heuristics.
- Core impact assessment:
  - Core Architecture: review/update required (`server/index.ts`, `server/event-image.test.ts`, `server/event-image.ts`).
  - Available Features: review/update required (`server/index.ts`, `server/event-image.test.ts`, `server/event-image.ts`).
  - Common Commands: review/update required (`package.json`).
  - Dependencies: review/update required (`package-lock.json`, `package.json`).
  - Environment: no direct path signal detected.
  - Agent System: no direct path signal detected.
- Files:
  - `GENTS.md` (modified)
  - `package-lock.json` (modified)
  - `package.json` (modified)
  - `server/index.ts` (modified)
  - `server/event-image.test.ts` (untracked)
  - `server/event-image.ts` (untracked)

### 2026-08-08 - Updated agent-facing project context

- Branch: `main`
- Affected files: 1 detected before updating `AGENTS.md`.
- Change types: modified: 1.
- Agent-related files: 1 detected.
- Core impact assessment:
  - Core Architecture: no direct path signal detected.
  - Available Features: no direct path signal detected.
  - Common Commands: no direct path signal detected.
  - Dependencies: no direct path signal detected.
  - Environment: no direct path signal detected.
  - Agent System: review/update required (`github/workflows/docker-publish.yml`).
- Files:
  - `github/workflows/docker-publish.yml` (modified)

### 2026-08-08 - Updated agent-facing project context

- Branch: `main`
- Affected files: 2 detected before updating `AGENTS.md`.
- Change types: modified: 2.
- Agent-related files: 2 detected.
- Core impact assessment:
  - Core Architecture: no direct path signal detected.
  - Available Features: no direct path signal detected.
  - Common Commands: no direct path signal detected.
  - Dependencies: no direct path signal detected.
  - Environment: no direct path signal detected.
  - Agent System: review/update required (`github/workflows/docker-publish.yml`).
- Files:
  - `github/workflows/docker-publish.yml` (modified)
  - `AGENTS.md` (modified)

### 2026-08-08 - Recorded repository changes

- Branch: `main`
- Affected files: 2 detected before updating `AGENTS.md`.
- Change types: modified: 2.
- Agent-related files: none detected by path heuristics.
- Core impact assessment:
  - Core Architecture: review/update required (`server/eventernote.ts`).
  - Available Features: review/update required (`server/eventernote.ts`).
  - Common Commands: no direct path signal detected.
  - Dependencies: no direct path signal detected.
  - Environment: no direct path signal detected.
  - Agent System: no direct path signal detected.
- Files:
  - `erver/eventernote.test.ts` (modified)
  - `server/eventernote.ts` (modified)

### 2026-08-08 - Recorded repository changes

- Branch: `main`
- Affected files: 3 detected before updating `AGENTS.md`.
- Change types: modified: 3.
- Agent-related files: none detected by path heuristics.
- Core impact assessment:
  - Core Architecture: review/update required (`server/eventernote.test.ts`, `server/eventernote.ts`).
  - Available Features: review/update required (`server/eventernote.test.ts`, `server/eventernote.ts`).
  - Common Commands: no direct path signal detected.
  - Dependencies: no direct path signal detected.
  - Environment: no direct path signal detected.
  - Agent System: no direct path signal detected.
- Files:
  - `GENTS.md` (modified)
  - `server/eventernote.test.ts` (modified)
  - `server/eventernote.ts` (modified)
## Architecture Notes

Document architecture decisions and integration notes relevant to agents here.

<!-- commit-and-push-with-agents:architecture:start -->
### Latest Change Footprint

- Last scan: `2026-08-08`.
- Most affected areas: `server` (8), `GENTS.md` (1), `shared` (1), `src` (1).
<!-- commit-and-push-with-agents:architecture:end -->
