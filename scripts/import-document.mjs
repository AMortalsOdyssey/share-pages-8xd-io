#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CATALOG_KEY = 'share_pages:catalog';
const DEFAULT_BUCKET = 'share-pages-content';

const args = parseArgs(process.argv.slice(2));
if (!args.file) usage('Missing required --file <path>');

const configPath = path.resolve(args.config || 'wrangler.jsonc');
const filePath = path.resolve(args.file);
const fileBytes = await readFile(filePath);
const content = fileBytes.toString('utf8');
const config = await readJsoncConfig(configPath);

const sourceType = normalizeSourceType(args.type || detectSourceType(filePath, content));
const project = cleanText(args.project || 'Documents');
const category = cleanText(args.category || 'General');
const title = cleanText(args.title || pickTitle(content, sourceType));
const slug = slugify(args.slug || title);
const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
const id = cleanText(args.id || `${slug}-${hash}`);
const articlePath = normalizePagePath(args.path || `/${slugify(project)}/${slugify(category)}/${id}/`);
const r2Bucket = cleanText(args.bucket || process.env.SHARE_PAGES_R2_BUCKET || readR2Bucket(config) || DEFAULT_BUCKET);
const kvNamespaceId = cleanText(args['namespace-id'] || process.env.SHARE_PAGES_CONFIG_NAMESPACE_ID || readKvNamespaceId(config));
const accountId = cleanText(args['account-id'] || process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || config.account_id || '');
const apiToken = cleanText(args['api-token'] || process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '');
const transport = chooseTransport(args.transport || process.env.SHARE_PAGES_IMPORT_TRANSPORT || 'auto', { accountId, apiToken });
const r2Prefix = cleanText(args['r2-prefix'] || `pages/${id}`);
const r2Base = r2Prefix.replace(/\/+$/, '');
const r2Key = `${r2Base}/${sourceFileName(sourceType)}`;
const faviconKey = `${r2Base}/favicon.svg`;
const now = new Date().toISOString();
const encrypted = args.encrypted === true || args.encrypted === 'true';

if (!kvNamespaceId) usage('Missing KV namespace id. Pass --namespace-id or keep kv_namespaces in wrangler.jsonc.');
if (!title) usage('Unable to determine title. Pass --title <title>.');
if (!slug) usage('Unable to determine slug. Pass --slug <slug>.');
if (!articlePath || articlePath === '/') usage('Invalid target path.');

const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'share-pages-import-'));

try {
  const startedAt = Date.now();
  const faviconPath = args.favicon ? path.resolve(args.favicon) : path.join(tmpDir, 'favicon.svg');
  if (!args.favicon) await writeFile(faviconPath, renderFavicon(title), 'utf8');
  const faviconBytes = await readFile(faviconPath);

  const catalog = await readRemoteCatalog({
    namespaceId: kvNamespaceId,
    configPath,
    transport,
    accountId,
    apiToken,
  });
  const existing = catalog.find((item) => item.id === id || item.path === articlePath);
  const nextArticle = {
    id,
    project,
    category,
    title,
    path: articlePath,
    r2Key,
    sourceType,
    faviconKey,
    r2Prefix: `${r2Base}/`,
    encrypted,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  const nextCatalog = upsertCatalogArticle(catalog, nextArticle);
  const catalogPath = path.join(tmpDir, 'catalog.json');
  const catalogJson = `${JSON.stringify({ articles: nextCatalog }, null, 2)}\n`;
  await writeFile(catalogPath, catalogJson, 'utf8');

  if (transport === 'api') {
    await putR2Object({
      accountId,
      apiToken,
      bucket: r2Bucket,
      key: r2Key,
      body: fileBytes,
      contentType: contentTypeForSource(sourceType),
    });
    await putR2Object({
      accountId,
      apiToken,
      bucket: r2Bucket,
      key: faviconKey,
      body: faviconBytes,
      contentType: 'image/svg+xml; charset=utf-8',
    });
    await putKvValue({
      accountId,
      apiToken,
      namespaceId: kvNamespaceId,
      key: CATALOG_KEY,
      body: catalogJson,
      contentType: 'application/json; charset=utf-8',
    });
  } else {
    runWrangler([
      'r2', 'object', 'put', `${r2Bucket}/${r2Key}`,
      '--file', filePath,
      '--content-type', contentTypeForSource(sourceType),
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
  }

  console.log(JSON.stringify({
    ok: true,
    transport,
    durationMs: Date.now() - startedAt,
    id,
    title,
    path: articlePath,
    sourceType,
    r2Key,
    faviconKey,
    catalogKey: CATALOG_KEY,
    encrypted,
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
  npm run import:document -- --file ./note.md --project Documents --category General --slug note

Options:
  --config <path>          Wrangler config path. Defaults to wrangler.jsonc.
  --namespace-id <id>      KV namespace id. Defaults to wrangler.jsonc kv_namespaces.
  --bucket <name>          R2 bucket name. Defaults to wrangler.jsonc r2_buckets.
  --transport <mode>       auto, api, or wrangler. Defaults to auto.
  --account-id <id>        Cloudflare account id for API transport.
  --api-token <token>      Cloudflare API token for API transport. Prefer env var.
  --project <name>         Project/group shown in the admin index.
  --category <name>        Category shown under the project.
  --title <title>          Article title. Defaults to source metadata or heading.
  --slug <slug>            URL slug seed. Defaults to title.
  --id <id>                Stable unique id. Defaults to slug plus content hash.
  --path <path>            Public path. Defaults to /project/category/id/.
  --type <type>            html, markdown, svg, mermaid, or text. Defaults to detection.
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

function chooseTransport(value, { accountId, apiToken }) {
  const requested = String(value || 'auto').trim().toLowerCase();
  if (!['auto', 'api', 'wrangler'].includes(requested)) usage(`Unsupported --transport: ${value}`);

  if (requested === 'api') {
    if (!accountId || !apiToken) {
      usage('API transport requires --account-id and --api-token, or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.');
    }
    return 'api';
  }

  if (requested === 'wrangler') return 'wrangler';
  return accountId && apiToken ? 'api' : 'wrangler';
}

async function readRemoteCatalog({ namespaceId, configPath, transport, accountId, apiToken }) {
  if (transport === 'api') {
    const response = await cloudflareFetch({
      accountId,
      apiToken,
      path: `/storage/kv/namespaces/${encodePathSegment(namespaceId)}/values/${encodePathSegment(CATALOG_KEY)}`,
      method: 'GET',
    });

    if (response.status === 404) return [];
    if (!response.ok) await throwCloudflareError(response, 'read KV catalog');

    try {
      const parsed = JSON.parse(await response.text());
      return Array.isArray(parsed) ? parsed : parsed.articles || [];
    } catch {
      return [];
    }
  }

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

async function putR2Object({ accountId, apiToken, bucket, key, body, contentType }) {
  const response = await cloudflareFetch({
    accountId,
    apiToken,
    path: `/r2/buckets/${encodePathSegment(bucket)}/objects/${encodeObjectKey(key)}`,
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
    },
    body,
  });

  if (!response.ok) await throwCloudflareError(response, `upload R2 object ${key}`);
}

async function putKvValue({ accountId, apiToken, namespaceId, key, body, contentType }) {
  const response = await cloudflareFetch({
    accountId,
    apiToken,
    path: `/storage/kv/namespaces/${encodePathSegment(namespaceId)}/values/${encodePathSegment(key)}`,
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
    },
    body,
  });

  if (!response.ok) await throwCloudflareError(response, `write KV key ${key}`);
}

async function cloudflareFetch({ accountId, apiToken, path: apiPath, method, headers = {}, body }) {
  return fetch(`https://api.cloudflare.com/client/v4/accounts/${encodePathSegment(accountId)}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...headers,
    },
    body,
  });
}

async function throwCloudflareError(response, action) {
  const text = await response.text();
  let message = text;
  try {
    const parsed = JSON.parse(text);
    message = JSON.stringify({
      success: parsed.success,
      errors: parsed.errors,
      messages: parsed.messages,
    });
  } catch {
    // Keep raw text.
  }
  throw new Error(`Cloudflare API failed to ${action}: ${response.status} ${message}`);
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value));
}

function encodeObjectKey(value) {
  return String(value).split('/').map(encodeURIComponent).join('/');
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

function detectSourceType(filePath, content) {
  const extension = path.extname(filePath).toLowerCase().replace(/^\./, '');
  if (extension === 'html' || extension === 'htm') return 'html';
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (extension === 'svg') return 'svg';
  if (extension === 'mmd' || extension === 'mermaid') return 'mermaid';
  const trimmed = content.trim();
  if (trimmed.startsWith('<!doctype html') || trimmed.startsWith('<!DOCTYPE html') || trimmed.startsWith('<html')) return 'html';
  if (trimmed.startsWith('<svg')) return 'svg';
  if (isMermaidSource(trimmed)) return 'mermaid';
  if (/^#{1,6}\s.+/m.test(trimmed) || /^[-*+]\s.+/m.test(trimmed) || /\[.+?\]\(.+?\)/.test(trimmed)) return 'markdown';
  return 'text';
}

function normalizeSourceType(value = '') {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'md') return 'markdown';
  if (normalized === 'txt') return 'text';
  if (['html', 'markdown', 'svg', 'mermaid', 'text'].includes(normalized)) return normalized;
  usage(`Unsupported --type: ${value}`);
}

function sourceFileName(sourceType) {
  if (sourceType === 'html') return 'index.html';
  if (sourceType === 'markdown') return 'index.md';
  if (sourceType === 'svg') return 'index.svg';
  if (sourceType === 'mermaid') return 'index.mmd';
  return 'index.txt';
}

function contentTypeForSource(sourceType) {
  if (sourceType === 'html') return 'text/html; charset=utf-8';
  if (sourceType === 'markdown') return 'text/markdown; charset=utf-8';
  if (sourceType === 'svg') return 'image/svg+xml; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function pickTitle(content, sourceType) {
  if (sourceType === 'html') {
    const titleMatch = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) return stripTags(titleMatch[1]);
    const headingMatch = content.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (headingMatch) return stripTags(headingMatch[1]);
  }

  if (sourceType === 'markdown') {
    const frontmatter = content.match(/^---[\s\S]*?\ntitle:\s*["']?([^"'\n]+)["']?[\s\S]*?\n---/i);
    if (frontmatter) return frontmatter[1];
    const heading = content.match(/^#\s+(.+)$/m);
    if (heading) return heading[1].replace(/[#*_`]/g, '').trim();
  }

  return stripTags(content).slice(0, 80) || 'Share Page';
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

function isMermaidSource(value = '') {
  return /^(graph|flowchart)\s+(TB|TD|BT|RL|LR)\b/m.test(String(value).trim()) ||
    /^(sequenceDiagram|classDiagram|stateDiagram|stateDiagram-v2|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|C4Context)\b/m.test(String(value).trim());
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
