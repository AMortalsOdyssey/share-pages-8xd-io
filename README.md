# Share Pages Worker

A generic Cloudflare Worker framework for publishing private or public HTML, Markdown, SVG, Mermaid, and text documents from your own Cloudflare account.

The repository contains only reusable application code. Document metadata belongs in Cloudflare KV, and document bodies/assets belong in Cloudflare R2.

## Features

- Admin login for the root document index.
- Cloudflare Turnstile verification.
- Server-signed CSRF protection for admin mutations.
- Per-article password settings.
- R2-backed source document and favicon storage.
- Runtime previews for HTML, Markdown, SVG, Mermaid, and plain text.
- KV-backed catalog and article settings.
- Worker-first routing so protected documents cannot bypass article auth.
- 8XD Cloudflare Hub at `/hub` for short links, uptime checks, inbound email indexing, and edge event aggregates.
- Optional Queue and Analytics Engine bindings for asynchronous event ingestion.
- Optional Email Worker handler for Cloudflare Email Routing.
- Optional QuickShare submodule for the broader HTML/Markdown/SVG/Mermaid sharing workflow.

## Repository Layout

- `src/index.js` - Worker application, Share Pages admin UI, and handler wiring.
- `src/hub.js` - 8XD Cloudflare Hub routes, short links, monitor checks, email handling, and event aggregation.
- `migrations/` - D1 migrations for Hub data.
- `public/` - generic static fallback assets.
- `scripts/import-document.mjs` - imports local HTML, Markdown, SVG, Mermaid, or text into R2 and updates the KV catalog.
- `scripts/import-html.mjs` - legacy HTML-only import helper.
- `wrangler.example.jsonc` - template for a local `wrangler.jsonc`.
- `vendor/quickshare-cloudflare` - optional QuickShare submodule.

Production `wrangler.jsonc` is intentionally ignored. Keep account-specific worker names, resource ids, domain routes, and public site keys local.

## Cloudflare Data Model

KV key `share_pages:catalog` stores:

```json
{
  "articles": [
    {
      "id": "example-1234abcd",
      "project": "Documents",
      "category": "General",
      "title": "Example",
      "path": "/documents/general/example-1234abcd/",
      "r2Key": "pages/example-1234abcd/index.md",
      "sourceType": "markdown",
      "faviconKey": "pages/example-1234abcd/favicon.svg",
      "r2Prefix": "pages/example-1234abcd/",
      "encrypted": false,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

Article settings are stored separately as `article:<path>` in the same KV namespace.
Admin mutation requests, such as article password and encryption changes, require both the signed admin cookie and a server-signed CSRF token rendered into the admin page. The token is submitted in the request body/header, not in the URL.

R2 stores:

- `pages/<id>/index.html` or `index.md` / `index.svg` / `index.mmd` / `index.txt`
- `pages/<id>/favicon.svg`

## 8XD Cloudflare Hub

The Hub is an optional layer behind the same admin login. It is available at `/hub` after deployment.

It adds:

- Short links at `/s/<slug>` and `/go/<slug>`, with click counts and daily aggregates.
- Site monitoring through Worker Cron Triggers.
- Inbound email metadata in D1 and raw `.eml` archival in R2.
- Event aggregation through D1, with optional Queue buffering and Analytics Engine writes.

Hub D1 tables:

- `hub_short_links`
- `hub_event_daily`
- `hub_monitor_targets`
- `hub_monitor_checks`
- `hub_inbound_emails`

Create the extra resources when enabling Hub:

```bash
npx wrangler d1 create 8xd-hub
npx wrangler r2 bucket create 8xd-mailbox
npx wrangler queues create 8xd-hub-events
```

Then add the generated D1 `database_id` to `wrangler.jsonc`, keep the bindings from `wrangler.example.jsonc`, and run:

```bash
npm run hub:migrate:remote
```

For local D1 development:

```bash
npm run hub:migrate:local
```

To receive email, enable Cloudflare Email Routing for the domain and route the desired address or catch-all rule to this Worker. Set `HUB_MAIL_FORWARD_TO` only when you also want Cloudflare to forward a copy to a verified destination address.

## Local Setup

Install dependencies:

```bash
npm install
```

Create a local config from the example:

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

Create or select these Cloudflare resources, then fill in `wrangler.jsonc`:

```bash
npx wrangler kv namespace create SHARE_PAGES_CONFIG
npx wrangler r2 bucket create share-pages-content
npx wrangler d1 create 8xd-hub
```

Configure secrets with Wrangler or the Cloudflare dashboard:

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put COOKIE_SIGNING_SECRET
npx wrangler secret put PASSWORD_CRYPTO_SECRET
```

## Import Documents

```bash
npm run import:document -- \
  --file ./note.md \
  --project Documents \
  --category General \
  --slug example-note
```

The document importer stores the original source in R2. Markdown, SVG, Mermaid, and text are rendered by the Worker at request time.

By default the importer uses `--transport auto`:

- If `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are available, it writes R2 and KV through the Cloudflare API in one Node process.
- Otherwise it falls back to Wrangler CLI, which is slower but works with `npx wrangler login`.

Recommended local-only fast import variables:

```bash
export CLOUDFLARE_ACCOUNT_ID=<your-account-id>
export CLOUDFLARE_API_TOKEN=<token-with-r2-and-kv-write-access>
```

Keep these values in your shell profile, password manager, or local `.env` workflow. Do not commit them.

Useful options:

- `--type <html|markdown|svg|mermaid|text>` overrides automatic type detection.
- `--transport <auto|api|wrangler>` chooses the upload backend.
- `--title <title>` sets the visible article title.
- `--path <path>` sets the public path directly.
- `--id <id>` sets the stable unique article id.
- `--favicon <path>` uploads an existing SVG favicon.
- `--encrypted` marks the catalog entry encrypted by default.

## Import HTML Legacy

```bash
npm run import:html -- \
  --file ./page.html \
  --project Documents \
  --category General \
  --slug example-page
```

Useful options:

- `--title <title>` sets the visible article title.
- `--path <path>` sets the public path directly.
- `--id <id>` sets the stable unique article id.
- `--favicon <path>` uploads an existing SVG favicon.
- `--encrypted` marks the catalog entry encrypted by default.

Both import scripts upload content and favicon to R2, then update `share_pages:catalog` in KV.

## QuickShare Submodule

Clone with submodules:

```bash
git clone --recurse-submodules <repo-url>
```

Initialize submodules after a normal clone:

```bash
git submodule update --init --recursive
```

Update QuickShare later:

```bash
git submodule update --remote vendor/quickshare-cloudflare
```

QuickShare remains independent from this Worker framework and keeps its own license and deployment model.

## Deploy

Run a dry deployment check:

```bash
npm run check
```

Deploy:

```bash
npm run deploy
```

## Migration Checklist For Another Computer

- Clone this repository with submodules.
- Copy or recreate local `wrangler.jsonc`.
- Log in to Cloudflare with `npx wrangler login`.
- Ensure the same KV namespace, R2 bucket, custom domain, Turnstile widget, and Worker secrets are available in the Cloudflare account.
- If Hub is enabled, also ensure the D1 database, optional mailbox R2 bucket, optional Queue, Cron Trigger, and Email Routing rule exist.
- Re-run `npm run check` before deploying.

## License

MIT
