# AGENTS.md

This file applies to the entire repository.

## Product contract

Eventernote Autofill turns one public event URL into one or more reviewable Eventernote drafts. It must never write externally without an explicit user confirmation. Keep the following behavior stable:

- Drafts and confirmation tokens are process-memory only. Do not persist event drafts, credentials, or submission tokens.
- Keep `EVENTERNOTE_WRITE_ENABLED=false` as the safe default.
- Keep Eventernote, dashboard, OpenAI, and deployment credentials on the server. Never expose them through Vite variables, API responses, logs, fixtures, or committed Compose values.
- Use descriptions only when a submitted or discovered source directly provides one. Do not generate, summarize, or translate a missing description.
- Preserve source and manual values. Infer opening and ending times only when missing, and label inferred evidence as low confidence.
- Match Eventernote entities automatically only at high confidence. The editor must retain an explicit existing/new entity override.
- Treat source URLs, redirects, linked pages, and remote images as untrusted. All remote fetches must continue through the safe-fetch boundary.
- Dashboard import is part of a successful submission. Do not start an Eventernote write when the dashboard integration is incomplete.

## Repository map

- `src/`: React/Vite review interface.
- `server/`: Node HTTP server, extraction, Eventernote integration, dashboard import, and in-memory draft state.
- `shared/`: types and utilities used by both browser and server builds.
- `Dockerfile`: production build and non-root runtime image.
- `docker-compose.yml`: Portainer stack definition using the published GHCR image.
- `.github/workflows/docker-publish.yml`: validation, image publication, and optional Portainer Git-stack redeploy.

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
- Maintain idempotent retries after partial Eventernote progress by preserving accepted IDs in the current in-memory draft.
- Do not broaden allowed outbound hosts, ports, content types, sizes, or redirect behavior without security tests.
- Keep user-visible Traditional Chinese text consistent with the existing interface. Keep code, configuration keys, and developer documentation in English.

## Deployment rules

- Production images are `ghcr.io/kitsunezu/eventernote-autofill:latest` plus immutable `sha-*` tags.
- Portainer owns runtime secrets and joins the existing external `eventernote-dashboard_eventernote-internal` network used by the deployed `eventernote-dashboard` stack. Re-check the live network name before changing the dashboard Compose project.
- Never commit real values for `APP_TOKEN`, `OPENAI_API_KEY`, `EVENTERNOTE_USERNAME`, `EVENTERNOTE_PASSWORD`, `DASHBOARD_IMPORT_TOKEN`, or deployment service tokens.
- A commit or successful image build is not proof of deployment. Verify the Actions publish job, Portainer stack update/container recreation, and the running container's `/health` response independently.
- Portainer Git redeploy requests must preserve the stack's existing `Env`; omitting it can clear saved environment variables before Compose interpolation.
