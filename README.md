# Eventernote Autofill

Private review flow for turning a source URL into verified Eventernote data. It accepts official pages, ticketing sites, X, Facebook, Instagram, and Eventernote pages. Social and incomplete sources are inspected for ticketing links, and the most complete parsed source becomes the extraction baseline. When OpenAI is configured, every parse is checked against cleaned source content, discovered ticketing pages, event images, and web search; separately scheduled sessions become independent review records, and high-confidence corrections can replace parsed values. Every value remains editable and requires explicit confirmation before an external write.

## Workflow

1. Paste one event URL on the centered landing screen. The result form appears only after parsing completes.
2. For social or incomplete pages, the server follows a limited set of recognized ticketing, purchase, and shortened links through the same safe-fetch boundary. It uses the most complete parsed page while retaining the submitted URL as the source.
3. The server removes scripts and navigation noise, then uses OpenAI Structured Outputs and web search to verify facts and split every separately scheduled public session into its own review record. Up to four validated event images are included as original-detail vision inputs so poster text can be read.
   Event descriptions are taken only from JSON-LD or metadata on the submitted or discovered page. If no source has a direct description, the field stays blank; OpenAI does not generate, summarize, translate, or enrich it. Event end times are accepted only when a source explicitly labels the event end, close, or finish time; they are never derived from an assumed duration.
4. Switch between sessions and review the event, place, performers, and image. Images can come from a URL or a JPEG/PNG/WebP upload up to 5 MB, with an on-page preview.
5. Choose `確認送出`. The browser sends the current values for a stateless submission check. Eventernote place/performer matching runs, and OpenAI resolves candidates to existing or new entities when confidence is sufficient. For a new performer, OpenAI fills the Eventernote reading without storing the review record on the server. Any unresolved choice returns to the editor.
6. Review the complete confirmation summary and approve the write. There is no separate save-and-check step.
7. The server creates missing performers and place, creates the event, then adds the image using the post-create form.

The server does not run a separate duplicate-event search before writing. Eventernote remains the authority for duplicate validation, and any duplicate response from the actual event submission is returned as an actionable error in the browser-held review record.

Review values, selected files, and partial submission progress are kept only in the current browser page. If Eventernote accepts an actor, place, or event but a later step fails, the API returns those IDs and retrying in the same open page continues from them. API restarts do not discard the open review, but closing or reloading the page does. Once the event exists, only its post-create image input remains editable in this tool.

## Local development

Requires Node.js 22. Copy `.env.example` to `.env.local`, load the variables in your shell, then:

```powershell
npm install
npm run dev
```

Open `http://localhost:5173`. The API listens on port `8790`.

For parser-only development, Eventernote credentials are optional. External writes remain disabled unless `EVENTERNOTE_WRITE_ENABLED=true` is explicitly set.

## Required production secrets

- `APP_TOKEN`: long random key entered by workspace users; protects analysis, search, check, and submission APIs.
- `EVENTERNOTE_USERNAME` / `EVENTERNOTE_PASSWORD`: dedicated Eventernote account, stored only in the server environment.
- `OPENAI_API_KEY`: optional; enables web-assisted verification and enrichment on every analysis. The default extraction model is `gpt-5.6-luna` and can be changed with `OPENAI_MODEL`.
- `OPENAI_API_KEY_ENV`: optional local/secret-manager alternative containing the name of another environment variable that holds the key. `OPENAI_API_KEY` takes precedence when both are set.
- `OPENAI_BASE_URL`: optional Responses API base URL. It defaults to `https://api.openai.com/v1`; set it only when using a trusted OpenAI-compatible provider because that provider receives `OPENAI_API_KEY` and event source content.

Never expose these values in the browser bundle, Git, Compose files, or logs. Rotate any value that has been pasted into a public issue or console transcript.

## Production deployment

The `main` branch publishes `ghcr.io/kitsunezu/eventernote-autofill:latest` and an immutable `sha-*` tag through GitHub Actions. The workflow runs lint, tests, and the production build before pushing the image.

`docker-compose.yml` is the Portainer stack definition. It exposes host port `3004` and reports healthy only when `GET /health` succeeds. Configure the environment values listed in `.env.example` in Portainer; never enter production secrets in Git or the Compose editor.

After the stack has been created, configure these repository deployment settings to enable automatic redeploys after future image publications:

- GitHub Actions variables: `PORTAINER_BASE_URL`, `PORTAINER_STACK_ID`, and `PORTAINER_ENDPOINT_ID`.
- GitHub Actions secrets: `PORTAINER_API_KEY`, `CF_ACCESS_CLIENT_ID`, and `CF_ACCESS_CLIENT_SECRET`.

The redeploy step is skipped until all six settings exist. It preserves the stack's saved environment while asking Portainer to pull the newly published image.

## Safety and operational notes

- Source and discovered-link fetching blocks loopback, private IPs, embedded credentials, nonstandard ports, non-HTML content, large bodies, and unsafe redirects. Linked-page discovery is bounded to five ticket-like candidates.
- Remote image fetching applies the same network boundary and accepts only JPEG, PNG, or WebP content up to 5 MB.
- Review records and selected images live only in browser memory. The server retains only short-lived analysis-job progress and does not retain review or confirmation state.
- The browser sends images only with the final submission request; remote image URLs still pass through the safe-fetch boundary.
- Eventernote forms, including the image form available after event creation, are discovered after login and mapped from the live pages. If a required form cannot be identified or Eventernote returns validation errors, the workflow stops, preserves the created event ID, and keeps the item for correction or a safe retry.
- Verify the live Eventernote account permissions and current form behavior with writes disabled before enabling production submissions.
- Respect Eventernote's terms and avoid bulk submission. This app submits one reviewed event at a time.

## Validation

```powershell
npm run lint
npm run test
npm run build
docker build -t eventernote-autofill .
```
