# Share Pages Worker

A generic Cloudflare Worker framework for publishing private or public HTML documents from your own Cloudflare account.

The repository contains only reusable application code. Document metadata belongs in Cloudflare KV, and document bodies/assets belong in Cloudflare R2.

## Features

- Admin login for the root document index.
- Cloudflare Turnstile verification.
- Per-article password settings.
- R2-backed HTML and favicon storage.
- KV-backed catalog and article settings.
- Worker-first routing so protected documents cannot bypass article auth.
- Optional QuickShare submodule for the broader HTML/Markdown/SVG/Mermaid sharing workflow.

## Repository Layout

- `src/index.js` - Worker application and admin UI.
- `public/` - generic static fallback assets.
- `scripts/import-html.mjs` - imports local HTML into R2 and updates the KV catalog.
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
      "r2Key": "pages/example-1234abcd/index.html",
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

R2 stores:

- `pages/<id>/index.html`
- `pages/<id>/favicon.svg`

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
```

Configure secrets with Wrangler or the Cloudflare dashboard:

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put COOKIE_SIGNING_SECRET
npx wrangler secret put PASSWORD_CRYPTO_SECRET
```

## Import HTML

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

The script uploads the HTML and favicon to R2, then updates `share_pages:catalog` in KV.

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
- Re-run `npm run check` before deploying.

## License

MIT
