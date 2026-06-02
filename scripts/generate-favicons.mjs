import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const publicDir = path.resolve('public');

const escapeHtml = (value = '') => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const stripTags = (value = '') => String(value)
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

async function listHtmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listHtmlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      files.push(fullPath);
    }
  }

  return files;
}

function pickTitle(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) return stripTags(titleMatch[1]);

  const headingMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (headingMatch) return stripTags(headingMatch[1]);

  return stripTags(html).slice(0, 40) || 'Share';
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

function injectFaviconLink(html) {
  if (/<link\b[^>]*rel=["'][^"']*icon/i.test(html)) return html;

  const link = '    <link rel="icon" href="./favicon.svg" type="image/svg+xml" />\n';
  if (/<title[^>]*>[\s\S]*?<\/title>/i.test(html)) {
    return html.replace(/(<title[^>]*>[\s\S]*?<\/title>)/i, `$1\n${link}`);
  }

  return html.replace(/(<head[^>]*>\s*)/i, `$1\n${link}`);
}

const htmlFiles = await listHtmlFiles(publicDir);

for (const htmlFile of htmlFiles) {
  const html = await readFile(htmlFile, 'utf8');
  const title = pickTitle(html);
  const dir = path.dirname(htmlFile);
  const faviconPath = path.join(dir, 'favicon.svg');
  const nextHtml = injectFaviconLink(html);

  await mkdir(dir, { recursive: true });
  await writeFile(faviconPath, renderFavicon(title));
  if (nextHtml !== html) {
    await writeFile(htmlFile, nextHtml);
  }

  console.log(`Generated favicon for ${path.relative(publicDir, htmlFile)} from "${title}"`);
}
