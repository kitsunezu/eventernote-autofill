# Eventernote Autofill

Private review flow for turning a source URL into verified Eventernote data. It accepts official pages, ticketing sites, X, Facebook, Instagram, and Eventernote pages. Social and incomplete sources are inspected for ticketing links, and the most complete parsed source becomes the extraction baseline. When OpenAI is configured, every parse is checked against cleaned source content, discovered ticketing pages, event images, and web search; separately scheduled sessions become independent drafts, and high-confidence corrections can replace parsed values. Every value remains editable and requires explicit confirmation before an external write.

## Workflow

1. Paste one event URL on the centered landing screen. The result form appears only after parsing completes.
2. For social or incomplete pages, the server follows a limited set of recognized ticketing, purchase, and shortened links through the same safe-fetch boundary. It uses the most complete parsed page while retaining the submitted URL as the source.
3. The server removes scripts and navigation noise, then uses OpenAI Structured Outputs and web search to verify facts and split every separately scheduled public session into its own draft. Up to four validated event images are included as original-detail vision inputs so poster text can be read.
   Event descriptions are taken only from JSON-LD or metadata on the submitted or discovered page. If no source has a direct description, the field stays blank; OpenAI does not generate, summarize, translate, or enrich it. Event end times are accepted only when a source explicitly labels the event end, close, or finish time; they are never derived from an assumed duration.
4. Switch between sessions and review the event, place, performers, and image. Images can come from a URL or a JPEG/PNG/WebP upload up to 5 MB, with an on-page preview.
5. Choose `確認送出`. The current edits are saved automatically, then Eventernote place/performer matching runs. OpenAI resolves candidates to existing or new entities when confidence is sufficient; parenthetical readings are also searched using the official short name. Any unresolved choice returns to the editor.
6. Review the complete confirmation summary and approve the write. There is no separate save-and-check step.
7. The server creates missing performers and place, creates the event, then adds the image using the post-create form.
8. The completed event is imported through `eventernote-dashboard`'s authenticated internal API.

Immediately before the event write, the server searches Eventernote for the same title, date, and venue. A match blocks submission and returns the existing event URL. Duplicate validation responses from Eventernote are also converted into a persistent, actionable error on the draft.

Partial progress is kept only for the current browser flow and server process. If Eventernote accepts an actor, place, or event but a later step fails, retrying in the same open page continues from the stored IDs. Closing or reloading the page discards the working item; drafts are never written to disk. Once the event exists, only its post-create image input remains editable in this tool.

## Local development

Requires Node.js 22. Copy `.env.example` to `.env.local`, load the variables in your shell, then:

```powershell
npm install
npm run dev
```

Open `http://localhost:5173`. The API listens on port `8790`.

For parser-only development, Eventernote credentials are optional. External writes remain disabled unless `EVENTERNOTE_WRITE_ENABLED=true` is explicitly set.

## Required production secrets

- `APP_TOKEN`: long random key entered by workspace users; protects every draft and action API.
- `EVENTERNOTE_USERNAME` / `EVENTERNOTE_PASSWORD`: dedicated Eventernote account, stored only in the server environment.
- `DASHBOARD_IMPORT_TOKEN`: shared only with `eventernote-dashboard`'s API service. Dashboard connectivity is required before submission begins.
- `DASHBOARD_USER_ID`: Eventernote user whose dashboard schedule receives imported events.
- `OPENAI_API_KEY`: optional; enables web-assisted verification and enrichment on every analysis. The default extraction model is `gpt-5.6-luna` and can be changed with `OPENAI_MODEL`.
- `OPENAI_API_KEY_ENV`: optional local/secret-manager alternative containing the name of another environment variable that holds the key. `OPENAI_API_KEY` takes precedence when both are set.
- `OPENAI_BASE_URL`: optional Responses API base URL. It defaults to `https://api.openai.com/v1`; set it only when using a trusted OpenAI-compatible provider because that provider receives `OPENAI_API_KEY` and event source content.

Never expose these values in the browser bundle, Git, Compose files, or logs. Rotate any value that has been pasted into a public issue or console transcript.

## Dashboard connection

The dashboard API must set the same `DASHBOARD_IMPORT_TOKEN`. Its internal endpoint is:

```http
POST /api/internal/events/import
Authorization: Bearer <shared token>
```

The production stack joins the existing `eventernote-dashboard_eventernote-internal` Docker network created by the dashboard Compose project. Set `DASHBOARD_API_URL=http://eventernote-api:8787` inside Docker; do not expose the internal import endpoint through a separate public port.

## Production deployment

The `main` branch publishes `ghcr.io/kitsunezu/eventernote-autofill:latest` and an immutable `sha-*` tag through GitHub Actions. The workflow runs lint, tests, and the production build before pushing the image.

`docker-compose.yml` is the Portainer stack definition. It exposes host port `3004`, joins the dashboard's existing internal network, and reports healthy only when `GET /health` succeeds. Configure the environment values listed in `.env.example` in Portainer; never enter production secrets in Git or the Compose editor.

After the stack has been created, configure these repository deployment settings to enable automatic redeploys after future image publications:

- GitHub Actions variables: `PORTAINER_BASE_URL`, `PORTAINER_STACK_ID`, and `PORTAINER_ENDPOINT_ID`.
- GitHub Actions secrets: `PORTAINER_API_KEY`, `CF_ACCESS_CLIENT_ID`, and `CF_ACCESS_CLIENT_SECRET`.

The redeploy step is skipped until all six settings exist. It preserves the stack's saved environment while asking Portainer to pull the newly published image.

## Safety and operational notes

- Source and discovered-link fetching blocks loopback, private IPs, embedded credentials, nonstandard ports, non-HTML content, large bodies, and unsafe redirects. Linked-page discovery is bounded to five ticket-like candidates.
- Remote image fetching applies the same network boundary and accepts only JPEG, PNG, or WebP content up to 5 MB.
- Drafts live in server memory only. Starting a new analysis replaces the current drafts, and choosing to parse another URL removes them explicitly. Startup removes orphaned upload files left by an interrupted session.
- Submission tokens bind to the exact draft revision and content hash and expire after ten minutes.
- Eventernote forms, including the image form available after event creation, are discovered after login and mapped from the live pages. If a required form cannot be identified or Eventernote returns validation errors, the workflow stops, preserves the created event ID, and keeps the item for correction or a safe retry.
- Verify the live Eventernote account permissions and current form behavior with writes disabled before enabling production submissions.
- Respect Eventernote's terms and avoid bulk submission. This app submits one reviewed draft at a time.

## Validation

```powershell
npm run lint
npm run test
npm run build
docker build -t eventernote-autofill .
```
