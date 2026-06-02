#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CATALOG_KEY = 'share_pages:catalog';
const DEFAULT_BUCKET = 'share-pages-content';

const args = parseArgs(process.argv.slice(2));
if (!args.file) usage('Missing required --file <html>');

const configPath = path.resolve(args.config || 'wrangler.jsonc');
const htmlPath = path.resolve(args.file);
const html = await readFile(htmlPath, 'utf8');
const config = await readJsoncConfig(configPath);

const project = cleanText(args.project || 'Documents');
const category = cleanText(args.category || 'General');
const title = cleanText(args.title || pickTitle(html));
const slug = slugify(args.slug || title);
const hash = createHash('sha256').update(html).digest('hex').slice(0, 8);
const id = cleanText(args.id || `${slug}-${hash}`);
const articlePath = normalizePagePath(args.path || `/${slugify(project)}/${slugify(category)}/${id}/`);
const r2Bucket = cleanText(args.bucket || process.env.SHARE_PAGES_R2_BUCKET || readR2Bucket(config) || DEFAULT_BUCKET);
const kvNamespaceId = cleanText(args['namespace-id'] || process.env.SHARE_PAGES_CONFIG_NAMESPACE_ID || readKvNamespaceId(config));
const r2Prefix = cleanText(args['r2-prefix'] || `pages/${id}`);
const r2Key = `${r2Prefix.replace(/\/+$/, '')}/index.html`;
const faviconKey = `${r2Prefix.replace(/\/+$/, '')}/favicon.svg`;
const now = new Date().toISOString();
const encrypted = args.encrypted === true || args.encrypted === 'true';

if (!kvNamespaceId) usage('Missing KV namespace id. Pass --namespace-id or keep kv_namespaces in wrangler.jsonc.');
if (!title) usage('Unable to determine title. Pass --title <title>.');
if (!slug) usage('Unable to determine slug. Pass --slug <slug>.');
if (!articlePath || articlePath === '/') usage('Invalid target path.');

const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'share-pages-import-'));

try {
  const faviconPath = args.favicon ? path.resolve(args.favicon) : path.join(tmpDir, 'favicon.svg');
  if (!args.favicon) await writeFile(faviconPath, renderFavicon(title), 'utf8');

  const catalog = await readRemoteCatalog(kvNamespaceId, configPath);
  const nextArticle = {
    id,
    project,
    category,
    title,
    path: articlePath,
    r2Key,
    faviconKey,
    r2Prefix: `${r2Prefix.replace(/\/+$/, '')}/`,
    encrypted,
    createdAt: catalog.find((item) => item.id === id || item.path === articlePath)?.createdAt || now,
    updatedAt: now,
  };

  const nextCatalog = upsertCatalogArticle(catalog, nextArticle);
  const catalogPath = path.join(tmpDir, 'catalog.json');
  await writeFile(catalogPath, `${JSON.stringify({ articles: nextCatalog }, null, 2)}\n`, 'utf8');

  runWrangler([
    'r2', 'object', 'put', `${r2Bucket}/${r2Key}`,
    '--file', htmlPath,
    '--content-type', 'text/html; charset=utf-8',
    '--remote',
    '--config', configPath,
  ]);
  runWrangler([
    'r2', 'object', 'put', `${r2Bucket}/${faviconKey}`,
    '--file', faviconPath,
    '--content-type', 'image/svg+xml; charset=utf-8',
    '--remote',
    '--config', configPath,
  ]);
  runWrangler([
    'kv', 'key', 'put', CATALOG_KEY,
    '--path', catalogPath,
    '--namespace-id', kvNamespaceId,
    '--remote',
    '--config', configPath,
  ]);

  console.log(JSON.stringify({
    ok: true,
    id,
    title,
    path: articlePath,
    r2Key,
    faviconKey,
    catalogKey: CATALOG_KEY,
  }, null, 2));
} finally {
  await rm(tmpDir, { recursive: true, force: true });
}

function parseArgs(values) {
  const parsed = {};

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) usage(`Unexpected argument: ${value}`);
    const name = value.slice(2);
    if (name === 'encrypted') {
      parsed.encrypted = true;
    } else {
      const next = values[index + 1];
      if (!next || next.startsWith('--')) usage(`Missing value for --${name}`);
      parsed[name] = next;
      index += 1;
    }
  }

  return parsed;
}

function usage(message) {
  if (message) console.error(message);
  console.error(`Usage:
  npm run import:html -- --file ./page.html --project Documents --category General --slug page-title

Options:
  --config <path>          Wrangler config path. Defaults to wrangler.jsonc.
  --namespace-id <id>      KV namespace id. Defaults to wrangler.jsonc kv_namespaces.
  --bucket <name>          R2 bucket name. Defaults to wrangler.jsonc r2_buckets.
  --project <name>         Project/group shown in the admin index.
  --category <name>        Category shown under the project.
  --title <title>          Article title. Defaults to <title> or <h1> from HTML.
  --slug <slug>            URL slug seed. Defaults to title.
  --id <id>                Stable unique id. Defaults to slug plus content hash.
  --path <path>            Public path. Defaults to /project/category/id/.
  --favicon <path>         Existing favicon SVG. Defaults to generated SVG.
  --encrypted              Mark catalog entry encrypted by default.
`);
  process.exit(1);
}

async function readJsoncConfig(configPath) {
  try {
    const raw = await readFile(configPath, 'utf8');
    return JSON.parse(stripJsonc(raw));
  } catch (error) {
    console.warn(`Unable to read ${configPath}; falling back to CLI options and env vars.`, error.message);
    return {};
  }
}

function stripJsonc(raw) {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function readR2Bucket(config) {
  const binding = (config.r2_buckets || []).find((item) => item.binding === 'SHARE_PAGES_CONTENT');
  return binding?.bucket_name || '';
}

function readKvNamespaceId(config) {
  const binding = (config.kv_namespaces || []).find((item) => item.binding === 'SHARE_PAGES_CONFIG');
  return binding?.id || '';
}

async function readRemoteCatalog(namespaceId, configPath) {
  const result = spawnSync('npx', [
    'wrangler', 'kv', 'key', 'get', CATALOG_KEY,
    '--namespace-id', namespaceId,
    '--remote',
    '--config', configPath,
  ], {
    encoding: 'utf8',
  });

  if (result.status !== 0) return [];

  const stdout = result.stdout.trim();
  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) return [];

  try {
    const parsed = JSON.parse(stdout.slice(jsonStart));
    return Array.isArray(parsed) ? parsed : parsed.articles || [];
  } catch {
    return [];
  }
}

function upsertCatalogArticle(catalog, article) {
  const filtered = catalog.filter((item) => item.id !== article.id && item.path !== article.path);
  filtered.push(article);
  return filtered.sort((left, right) => (
    String(left.project || '').localeCompare(String(right.project || '')) ||
    String(left.category || '').localeCompare(String(right.category || '')) ||
    String(left.title || '').localeCompare(String(right.title || ''))
  ));
}

function runWrangler(args) {
  const result = spawnSync('npx', ['wrangler', ...args], {
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function pickTitle(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) return stripTags(titleMatch[1]);

  const headingMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (headingMatch) return stripTags(headingMatch[1]);

  return stripTags(html).slice(0, 80) || 'Share Page';
}

function stripTags(value = '') {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function slugify(value = '') {
  const ascii = String(value)
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return ascii || createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function normalizePagePath(value = '') {
  let next = String(value).trim();
  if (!next.startsWith('/')) next = `/${next}`;
  if (next.endsWith('/index.html')) next = next.slice(0, -'index.html'.length);
  if (!next.endsWith('/')) next = `${next}/`;
  return next.replace(/\/+/g, '/');
}

function renderFavicon(title) {
  const label = pickLabel(title);
  const colors = colorSet(title);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${colors.start}"/>
      <stop offset="1" stop-color="${colors.end}"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#g)"/>
  <text x="50%" y="52%" text-anchor="middle" dominant-baseline="middle"
    font-family="Inter, Arial, sans-serif" font-size="34" font-weight="800" fill="#fff">${escapeHtml(label)}</text>
</svg>
`;
}

function pickLabel(title) {
  const asciiWord = title.match(/[A-Za-z0-9]/);
  if (asciiWord) return asciiWord[0].toUpperCase();

  const cjkChar = title.match(/[\u4e00-\u9fff]/u);
  if (cjkChar) return cjkChar[0];

  return 'S';
}

function colorSet(seed) {
  const hash = createHash('sha256').update(seed).digest('hex');
  const hue = Number.parseInt(hash.slice(0, 6), 16) % 360;
  return {
    start: `hsl(${hue}, 74%, 44%)`,
    end: `hsl(${(hue + 36) % 360}, 82%, 34%)`,
  };
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
