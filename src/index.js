import { marked } from 'marked';

const ADMIN_COOKIE = 'share_pages_admin';
const AUTH_TTL_SECONDS = 30 * 24 * 60 * 60;
const CATALOG_KEY = 'share_pages:catalog';
const LEGACY_REDIRECTS_KEY = 'share_pages:legacy_redirects';
const DEFAULT_PROJECT = 'Documents';
const DEFAULT_CATEGORY = 'General';

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error('share-pages worker error', error);
      return htmlResponse(renderErrorPage(), 500);
    }
  },
};

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const normalizedPath = normalizePagePath(url.pathname);
  const catalog = await getArticleCatalog(env);
  const requestedArticle = findArticleForRequestPath(catalog, url.pathname);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  const legacyTarget = await getLegacyRedirectTarget(env, normalizedPath);
  if (legacyTarget) return redirect(legacyTarget);

  if (isInternalAssetPath(url.pathname)) {
    return htmlResponse(renderErrorPage('页面不存在'), 404);
  }

  if (url.pathname === '/logout' && request.method === 'GET') {
    return redirect('/', { 'Set-Cookie': clearCookie(ADMIN_COOKIE) });
  }

  if (url.pathname === '/login' && request.method === 'GET') {
    if (await isAdminAuthenticated(request, env)) return redirect('/');
    return htmlResponse(renderLoginPage({
      mode: 'admin',
      turnstileSiteKey: getTurnstileSiteKey(env),
    }));
  }

  if (url.pathname === '/login' && request.method === 'POST') {
    return handleAdminLogin(request, env);
  }

  if (url.pathname === '/unlock' && request.method === 'POST') {
    return handleArticleUnlock(request, env, catalog);
  }

  if (url.pathname === '/admin/article' && request.method === 'POST') {
    return handleArticleSettingsUpdate(request, env, catalog);
  }

  if (isRootPage(url.pathname)) {
    if (!(await isAdminAuthenticated(request, env))) {
      return htmlResponse(renderLoginPage({
        mode: 'admin',
        turnstileSiteKey: getTurnstileSiteKey(env),
      }));
    }

    return htmlResponse(await renderAdminPage(env, {
      catalog,
      notice: url.searchParams.get('notice') || '',
      error: url.searchParams.get('error') || '',
    }));
  }

  if (requestedArticle) {
    const setting = await getArticleSetting(env, requestedArticle.path, requestedArticle);
    if (
      setting.encrypted &&
      !isPublicArticleAssetRequest(url.pathname) &&
      !(await isArticleAuthenticated(request, env, requestedArticle.path, setting))
    ) {
      if (!isArticlePageRequest(url.pathname)) {
        return htmlResponse(renderErrorPage('页面不存在'), 404);
      }
      return htmlResponse(renderLoginPage({
        mode: 'article',
        path: requestedArticle.path,
        title: '请输入访问密码',
        turnstileSiteKey: getTurnstileSiteKey(env),
      }));
    }
  }

  if (requestedArticle) {
    const articleAssetResponse = await fetchArticleAsset(request, env, requestedArticle);
    if (articleAssetResponse.status !== 404) return articleAssetResponse;
  }

  const assetResponse = await env.ASSETS.fetch(request);
  if (assetResponse.status !== 404) return assetResponse;

  if (url.pathname !== '/') return redirect('/');
  return assetResponse;
}

async function handleAdminLogin(request, env) {
  const formData = await request.formData();
  const password = String(formData.get('password') || '');
  const turnstile = await verifyTurnstile(request, env, formData);

  if (!turnstile.ok) {
    return htmlResponse(renderLoginPage({
      mode: 'admin',
      error: turnstile.error,
      turnstileSiteKey: getTurnstileSiteKey(env),
    }), 401);
  }

  if (password !== getAuthPassword(env)) {
    return htmlResponse(renderLoginPage({
      mode: 'admin',
      error: '密码错误，请重试',
      turnstileSiteKey: getTurnstileSiteKey(env),
    }), 401);
  }

  return redirect('/', {
    'Set-Cookie': await createSignedCookie(ADMIN_COOKIE, 'admin', env, request),
  });
}

async function handleArticleUnlock(request, env, catalog) {
  const formData = await request.formData();
  const password = String(formData.get('password') || '');
  const path = normalizePagePath(String(formData.get('path') || '/'));
  const turnstile = await verifyTurnstile(request, env, formData);
  const article = findArticle(catalog, path);

  if (!article) {
    return htmlResponse(renderErrorPage('页面不存在'), 404);
  }

  const setting = await getArticleSetting(env, path, article);
  if (!setting.encrypted) return redirect(path);

  if (!turnstile.ok) {
    return htmlResponse(renderLoginPage({
      mode: 'article',
      path,
      title: '请输入访问密码',
      error: turnstile.error,
      turnstileSiteKey: getTurnstileSiteKey(env),
    }), 401);
  }

  if (password !== await getArticlePassword(env, setting)) {
    return htmlResponse(renderLoginPage({
      mode: 'article',
      path,
      title: '请输入访问密码',
      error: '密码错误，请重试',
      turnstileSiteKey: getTurnstileSiteKey(env),
    }), 401);
  }

  return redirect(path, {
    'Set-Cookie': await createSignedCookie(articleCookieName(path), articleCookieValue(path, setting), env, request),
  });
}

async function handleArticleSettingsUpdate(request, env, catalog) {
  const jsonMode = wantsJson(request);
  if (!(await isAdminAuthenticated(request, env))) {
    if (jsonMode) return jsonResponse({ ok: false, error: '请重新登录后再保存' }, 401);
    return redirect('/login');
  }

  let path = '/';

  try {
    const formData = await request.formData();
    path = normalizePagePath(String(formData.get('path') || '/'));
    const article = findArticle(catalog, path);

    if (!article) {
      console.warn('article settings update rejected: unknown article', { path });
      if (jsonMode) return jsonResponse({ ok: false, error: '没有找到这篇文章' }, 404);
      return redirect('/?error=unknown-article');
    }

    const action = normalizeArticleAction(String(formData.get('action') || 'password'));
    const enteredPassword = String(formData.get('password') || '').trim();
    const currentSetting = await getArticleSetting(env, path, article);
    const currentPassword = await getArticlePassword(env, currentSetting);
    const now = new Date().toISOString();
    let notice = '设置已保存';
    let setting;

    if (action === 'encrypt') {
      if (!enteredPassword) {
        console.warn('article settings update rejected: encrypted without password', { path, action });
        if (jsonMode) return jsonResponse({ ok: false, error: '请先设置密码' }, 400);
        return redirect(`/?error=${encodeURIComponent('请先设置密码')}`);
      }

      setting = {
        encrypted: true,
        passwordCipher: await encryptPassword(enteredPassword, env),
        version: newSettingVersion(),
        updatedAt: now,
      };
      notice = '文章已加密';
    } else if (action === 'decrypt') {
      setting = {
        encrypted: false,
        version: newSettingVersion(),
        updatedAt: now,
      };
      if (currentPassword) {
        setting.passwordCipher = await encryptPassword(currentPassword, env);
      }
      notice = '文章已解除加密';
    } else {
      const hasPassword = Boolean(enteredPassword);
      setting = {
        encrypted: currentSetting.encrypted && hasPassword,
        version: newSettingVersion(),
        updatedAt: now,
      };
      if (hasPassword) {
        setting.passwordCipher = await encryptPassword(enteredPassword, env);
        notice = '密码已设置';
      } else {
        notice = currentSetting.encrypted ? '密码已清空，文章已解除加密' : '密码已清空';
      }
    }

    await putArticleSetting(env, path, setting);
    console.info('article settings updated', {
      path,
      action,
      encrypted: setting.encrypted,
      hasPassword: Boolean(await getArticlePassword(env, setting)),
      passwordChanged: action === 'password',
    });

    const articleRow = await getArticleAdminRow(env, article);
    const responseBody = {
      ok: true,
      notice,
      article: articleRow,
    };
    const headers = {
      'Set-Cookie': clearCookie(articleCookieName(path)),
    };

    if (jsonMode) return jsonResponse(responseBody, 200, headers);
    return redirect(`/?notice=${encodeURIComponent(notice)}`, headers);
  } catch (error) {
    console.error('article settings update failed', { path, error });
    const message = articleSettingsErrorMessage(error);

    if (jsonMode) return jsonResponse({ ok: false, error: message }, 500);
    return redirect(`/?error=${encodeURIComponent(message)}`);
  }
}

function normalizeArticleAction(action) {
  if (action === 'encrypt' || action === 'decrypt' || action === 'password') return action;
  return 'password';
}

function articleSettingsErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (message.includes('PASSWORD_CRYPTO_SECRET')) return '密码加密配置缺失，暂时无法保存密码';
  if (message.includes('SHARE_PAGES_CONFIG')) return '配置存储不可用，暂时无法保存设置';
  return '设置保存失败，请稍后重试';
}

function isRootPage(pathname) {
  return pathname === '/' || pathname === '/index.html';
}

function isInternalAssetPath(pathname) {
  const firstSegment = pathname.split('/').filter(Boolean)[0] || '';
  return firstSegment.startsWith('_') || firstSegment.startsWith('.');
}

function isArticlePageRequest(pathname) {
  return (
    pathname.endsWith('/') ||
    pathname.endsWith('/index.html') ||
    !pathExtension(pathname)
  );
}

async function getArticleCatalog(env) {
  if (!env.SHARE_PAGES_CONFIG) {
    console.warn('catalog load skipped: SHARE_PAGES_CONFIG binding is missing');
    return [];
  }

  const raw = await env.SHARE_PAGES_CONFIG.get(CATALOG_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : parsed.articles;
    if (!Array.isArray(items)) return [];

    return items
      .map(normalizeCatalogArticle)
      .filter(Boolean)
      .sort(compareCatalogArticles);
  } catch (error) {
    console.error('failed to parse article catalog', { key: CATALOG_KEY, error });
    return [];
  }
}

function normalizeCatalogArticle(item) {
  if (!item || typeof item !== 'object') return null;

  const id = String(item.id || '').trim();
  const title = String(item.title || '').trim();
  const path = normalizePagePath(String(item.path || '').trim());
  const r2Key = String(item.r2Key || '').trim();

  if (!id || !title || !path || path === '/' || !r2Key) return null;

  return {
    id,
    project: String(item.project || DEFAULT_PROJECT).trim() || DEFAULT_PROJECT,
    category: String(item.category || DEFAULT_CATEGORY).trim() || DEFAULT_CATEGORY,
    title,
    path,
    r2Key,
    sourceType: normalizeArticleSourceType(item.sourceType || item.contentType || '', r2Key),
    faviconKey: String(item.faviconKey || '').trim(),
    r2Prefix: String(item.r2Prefix || '').trim(),
    encrypted: Boolean(item.encrypted),
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
  };
}

function compareCatalogArticles(left, right) {
  return (
    left.project.localeCompare(right.project) ||
    left.category.localeCompare(right.category) ||
    left.title.localeCompare(right.title) ||
    left.path.localeCompare(right.path)
  );
}

async function getLegacyRedirectTarget(env, normalizedPath) {
  if (!env.SHARE_PAGES_CONFIG) return '';

  const raw = await env.SHARE_PAGES_CONFIG.get(LEGACY_REDIRECTS_KEY);
  if (!raw) return '';

  try {
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed)
      ? parsed
      : Object.entries(parsed).map(([from, to]) => ({ from, to }));

    for (const entry of entries) {
      const from = normalizePagePath(Array.isArray(entry) ? entry[0] : entry.from);
      const to = normalizePagePath(Array.isArray(entry) ? entry[1] : entry.to);
      if (from === normalizedPath && to && to !== '/') return to;
    }
  } catch (error) {
    console.error('failed to parse legacy redirects', { key: LEGACY_REDIRECTS_KEY, error });
  }

  return '';
}

function findArticle(catalog, path) {
  return catalog.find((article) => article.path === path) || null;
}

function findArticleForRequestPath(catalog, pathname) {
  const normalizedPath = normalizePagePath(pathname);
  return catalog.find((article) => (
    normalizedPath === article.path ||
    pathname === article.path ||
    pathname.startsWith(article.path)
  )) || null;
}

function articleAssetPath(article, pathname) {
  let suffix = pathname.startsWith(article.path) ? pathname.slice(article.path.length) : '';
  if (!suffix || suffix === '/') suffix = 'index.html';
  if (suffix.startsWith('/')) suffix = suffix.slice(1);
  return suffix;
}

async function fetchArticleAsset(request, env, article) {
  const pathname = new URL(request.url).pathname;
  const suffix = articleAssetPath(article, pathname);
  const key = articleObjectKey(article, suffix);
  if (!key) return htmlResponse(renderErrorPage('页面不存在'), 404);

  const bucket = getContentBucket(env);
  const object = await bucket.get(key);
  if (!object) return htmlResponse(renderErrorPage('页面不存在'), 404);

  if (suffix === 'index.html' && article.sourceType !== 'html') {
    const rawContent = await object.text();
    return htmlResponse(renderArticleSourceDocument(article, rawContent));
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', contentTypeForKey(key));
  headers.set('Cache-Control', key.endsWith('/index.html') ? 'no-store' : 'public, max-age=3600');

  return new Response(request.method === 'HEAD' ? null : object.body, {
    status: 200,
    headers,
  });
}

function articleObjectKey(article, suffix) {
  if (!suffix || suffix.includes('..') || suffix.startsWith('/')) return '';
  if (suffix === 'index.html') return article.r2Key;
  if (suffix === 'favicon.svg' && article.faviconKey) return article.faviconKey;
  if (!article.r2Prefix) return '';
  return `${article.r2Prefix.replace(/\/?$/, '/')}${suffix}`;
}

function normalizeArticleSourceType(value, r2Key = '') {
  const explicit = String(value || '').trim().toLowerCase();
  if (['html', 'markdown', 'md', 'svg', 'mermaid', 'text', 'txt'].includes(explicit)) {
    if (explicit === 'md') return 'markdown';
    if (explicit === 'txt') return 'text';
    return explicit;
  }

  const extension = pathExtension(r2Key).toLowerCase();
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (extension === 'svg') return 'svg';
  if (extension === 'mmd' || extension === 'mermaid') return 'mermaid';
  if (extension === 'txt') return 'text';
  return 'html';
}

function renderArticleSourceDocument(article, rawContent) {
  if (article.sourceType === 'markdown') return renderMarkdownSourceDocument(article, rawContent);
  if (article.sourceType === 'svg') return renderSvgSourceDocument(article, rawContent);
  if (article.sourceType === 'mermaid') return renderMermaidSourceDocument(article, rawContent);
  if (article.sourceType === 'text') return renderTextSourceDocument(article, rawContent);
  return rawContent;
}

function renderMarkdownSourceDocument(article, markdown) {
  const renderer = new marked.Renderer();
  const originalCodeRenderer = renderer.code.bind(renderer);
  const outlineItems = [];
  const headingCounts = new Map();
  const markdownBody = stripLeadingFrontmatter(markdown);

  renderer.heading = function heading(token) {
    const inlineHtml = this.parser.parseInline(token.tokens);
    const headingText = cleanHeadingText(stripTags(inlineHtml) || token.text || '');
    const id = uniqueHeadingId(headingText, headingCounts);
    outlineItems.push({
      id,
      text: headingText,
      depth: Math.min(Math.max(Number(token.depth) || 1, 1), 6),
    });

    return `<h${token.depth} id="${escapeHtml(id)}" data-outline-heading="${escapeHtml(id)}">${inlineHtml}</h${token.depth}>\n`;
  };

  renderer.code = (tokenOrCode, infostring, escaped) => {
    const code = typeof tokenOrCode === 'object' && tokenOrCode !== null ? tokenOrCode.text : tokenOrCode;
    const language = typeof tokenOrCode === 'object' && tokenOrCode !== null ? tokenOrCode.lang : infostring;
    const normalizedLanguage = String(language || '').toLowerCase();

    if (normalizedLanguage === 'mermaid' || isMermaidSource(code)) {
      return `<div class="mermaid">${escapeHtml(code)}</div>`;
    }

    if (normalizedLanguage === 'svg') {
      return `<div class="embedded-svg">${code}</div>`;
    }

    return originalCodeRenderer(tokenOrCode, infostring, escaped);
  };

  const htmlContent = marked.parse(markdownBody, {
    gfm: true,
    breaks: true,
    renderer,
  });

  return renderSourceViewer(article, htmlContent, {
    bodyClass: 'markdown-body',
    extraHead: `${sourceHighlightStyle()}${sourceMermaidScript()}`,
    extraBody: `${sourceHighlightScript()}${sourceOutlineScript()}`,
    outlineItems,
  });
}

function renderSvgSourceDocument(article, svg) {
  return renderSourceViewer(article, `<div class="svg-viewer">${svg}</div>`, {
    bodyClass: 'source-centered',
  });
}

function renderMermaidSourceDocument(article, mermaidSource) {
  return renderSourceViewer(article, `<div class="mermaid">${escapeHtml(extractMermaidSource(mermaidSource))}</div>`, {
    bodyClass: 'source-centered',
    extraHead: sourceMermaidScript(),
  });
}

function renderTextSourceDocument(article, text) {
  return renderSourceViewer(article, `<pre><code>${escapeHtml(text)}</code></pre>`, {
    bodyClass: 'text-body',
    extraHead: sourceHighlightStyle(),
    extraBody: sourceHighlightScript(),
  });
}

function renderSourceViewer(article, body, options = {}) {
  const bodyClass = options.bodyClass || 'source-body';
  const outlineHtml = renderOutline(options.outlineItems || []);
  const layoutClass = outlineHtml ? 'source-layout has-outline' : 'source-layout';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(article.title)}</title>
  <link rel="icon" href="${escapeHtml(article.path)}favicon.svg" type="image/svg+xml" />
  <style>
    :root {
      color-scheme: light;
      --ink: #172033;
      --muted: #5b6a7f;
      --line: #d9e2ec;
      --paper: #ffffff;
      --wash: #f5f7fb;
      --accent: #0f766e;
      --accent-soft: #d9f7f2;
      --accent-strong: #0b5f58;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      background: var(--wash);
      color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.72;
      letter-spacing: 0;
    }
    .source-layout {
      width: min(940px, calc(100vw - 32px));
      margin: 36px auto;
    }
    .source-layout.has-outline {
      width: min(1240px, calc(100vw - 32px));
      display: grid;
      grid-template-columns: minmax(0, 920px) 260px;
      align-items: start;
      gap: 24px;
    }
    main {
      min-width: 0;
      padding: clamp(22px, 4vw, 42px);
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 18px 45px rgba(23, 32, 51, 0.08);
    }
    h1, h2, h3 { line-height: 1.25; letter-spacing: 0; }
    h1 { margin-top: 0; font-size: clamp(28px, 5vw, 42px); }
    h2 { margin-top: 36px; padding-top: 18px; border-top: 1px solid var(--line); font-size: 24px; }
    h3 { margin-top: 24px; font-size: 19px; }
    h1[id], h2[id], h3[id], h4[id], h5[id], h6[id] { scroll-margin-top: 24px; }
    a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 3px; }
    code {
      padding: 0.15em 0.35em;
      border-radius: 5px;
      background: var(--accent-soft);
      color: #075e54;
      font-size: 0.92em;
    }
    pre {
      overflow-x: auto;
      padding: 18px;
      border-radius: 8px;
      background: #111827;
      color: #d1fae5;
    }
    pre code { padding: 0; background: transparent; color: inherit; }
    blockquote {
      margin: 22px 0;
      padding: 12px 18px;
      border-left: 4px solid var(--accent);
      background: #f8fafc;
      color: var(--muted);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      display: block;
      overflow-x: auto;
    }
    th, td { padding: 10px 12px; border: 1px solid var(--line); text-align: left; }
    th { background: #eef6f5; }
    img, svg { max-width: 100%; height: auto; }
    .source-centered {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .source-centered .source-layout { margin: 0 auto; }
    .svg-viewer, .embedded-svg, .mermaid {
      overflow: auto;
      max-width: 100%;
      padding: 14px;
      border-radius: 8px;
      background: #ffffff;
      border: 1px solid var(--line);
    }
    .doc-outline {
      position: sticky;
      top: 24px;
      max-height: calc(100vh - 48px);
      padding: 14px 0;
      overflow: hidden;
    }
    .outline-card {
      max-height: calc(100vh - 76px);
      overflow-y: auto;
      padding: 18px 12px 18px 18px;
      background: rgba(255, 255, 255, 0.78);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 14px 35px rgba(23, 32, 51, 0.07);
      scrollbar-width: thin;
      scrollbar-color: rgba(15, 118, 110, 0.34) transparent;
    }
    .outline-kicker {
      margin: 0 0 10px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .outline-list {
      display: grid;
      gap: 2px;
    }
    .outline-link {
      display: block;
      min-height: 28px;
      padding: 5px 8px;
      border-left: 3px solid transparent;
      border-radius: 6px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.35;
      text-decoration: none;
      transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease;
    }
    .outline-link:hover {
      background: var(--accent-soft);
      color: var(--accent-strong);
    }
    .outline-link.is-active {
      background: #eef6f5;
      border-left-color: var(--accent);
      color: var(--ink);
      font-weight: 700;
    }
    .outline-depth-1 { padding-left: 8px; }
    .outline-depth-2 { padding-left: 18px; }
    .outline-depth-3 { padding-left: 30px; }
    .outline-depth-4 { padding-left: 42px; }
    .outline-depth-5 { padding-left: 54px; }
    .outline-depth-6 { padding-left: 66px; }
    @media (max-width: 1120px) {
      .source-layout.has-outline {
        display: block;
        width: min(940px, calc(100vw - 32px));
      }
      .doc-outline { display: none; }
    }
  </style>
  ${options.extraHead || ''}
</head>
<body class="${escapeHtml(bodyClass)}">
  <div class="${layoutClass}">
    <main>
      ${body}
    </main>
    ${outlineHtml}
  </div>
  ${options.extraBody || ''}
</body>
</html>`;
}

function renderOutline(items = []) {
  const usableItems = items.filter((item) => item.id && item.text);
  if (usableItems.length < 2) return '';

  return `<aside class="doc-outline" aria-label="文档目录">
    <div class="outline-card">
      <div class="outline-kicker">Outline</div>
      <nav class="outline-list">
        ${usableItems.map((item) => `<a class="outline-link outline-depth-${item.depth}" href="#${escapeHtml(item.id)}" data-outline-link="${escapeHtml(item.id)}">${escapeHtml(item.text)}</a>`).join('')}
      </nav>
    </div>
  </aside>`;
}

function sourceHighlightStyle() {
  return '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/styles/atom-one-dark.min.css">';
}

function sourceHighlightScript() {
  return `<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.7.0/highlight.min.js"></script>
  <script>
    document.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
    });
  </script>`;
}

function sourceOutlineScript() {
  return `<script>
    document.addEventListener('DOMContentLoaded', () => {
      const headings = Array.from(document.querySelectorAll('[data-outline-heading]'));
      const links = Array.from(document.querySelectorAll('[data-outline-link]'));
      if (!headings.length || !links.length) return;

      const linkById = new Map(links.map((link) => [link.dataset.outlineLink, link]));
      let activeId = '';
      let ticking = false;

      const setActive = (id) => {
        if (!id || id === activeId) return;
        activeId = id;

        for (const link of links) {
          link.classList.toggle('is-active', link.dataset.outlineLink === id);
        }

        const activeLink = linkById.get(id);
        if (activeLink) {
          activeLink.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        }
      };

      const updateActive = () => {
        ticking = false;
        let next = headings[0].id;

        for (const heading of headings) {
          const rect = heading.getBoundingClientRect();
          if (rect.top <= 132) next = heading.id;
          else break;
        }

        setActive(next);
      };

      const scheduleUpdate = () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(updateActive);
      };

      for (const link of links) {
        link.addEventListener('click', (event) => {
          const id = link.dataset.outlineLink;
          const target = id ? document.getElementById(id) : null;
          if (!target) return;
          event.preventDefault();
          target.scrollIntoView({ block: 'start', behavior: 'smooth' });
          window.history.replaceState(null, '', '#' + encodeURIComponent(id));
          setActive(id);
        });
      }

      window.addEventListener('scroll', scheduleUpdate, { passive: true });
      window.addEventListener('resize', scheduleUpdate);
      updateActive();
    });
  </script>`;
}

function sourceMermaidScript() {
  return `<script src="https://cdn.jsdelivr.net/npm/mermaid@11.6.0/dist/mermaid.min.js"></script>
  <script>
    document.addEventListener('DOMContentLoaded', () => {
      if (!window.mermaid) return;
      window.mermaid.initialize({
        startOnLoad: true,
        securityLevel: 'loose',
        theme: window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
      });
      window.mermaid.run({ nodes: document.querySelectorAll('.mermaid') }).catch((error) => {
        console.error('Mermaid render failed', error);
      });
    });
  </script>`;
}

function isMermaidSource(value = '') {
  return /^(graph|flowchart)\s+(TB|TD|BT|RL|LR)\b/m.test(String(value).trim()) ||
    /^(sequenceDiagram|classDiagram|stateDiagram|stateDiagram-v2|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline|C4Context)\b/m.test(String(value).trim());
}

function extractMermaidSource(value = '') {
  const trimmed = String(value).trim();
  const fenced = trimmed.match(/```mermaid\n([\s\S]+?)\n```/);
  return fenced?.[1]?.trim() || trimmed;
}

function stripLeadingFrontmatter(value = '') {
  return String(value).replace(/^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, '');
}

function stripTags(value = '') {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanHeadingText(value = '') {
  return String(value).replace(/\s+/g, ' ').trim() || 'Untitled';
}

function uniqueHeadingId(text, counts) {
  const base = slugifyHeading(text) || `section-${shortTextHash(text)}`;
  const count = counts.get(base) || 0;
  counts.set(base, count + 1);
  return count ? `${base}-${count + 1}` : base;
}

function slugifyHeading(value = '') {
  return String(value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function shortTextHash(value = '') {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function getContentBucket(env) {
  if (!env.SHARE_PAGES_CONTENT) throw new Error('SHARE_PAGES_CONTENT R2 binding is missing');
  return env.SHARE_PAGES_CONTENT;
}

function contentTypeForKey(key) {
  const extension = pathExtension(key).toLowerCase();
  if (extension === 'html') return 'text/html; charset=utf-8';
  if (extension === 'md' || extension === 'markdown') return 'text/markdown; charset=utf-8';
  if (extension === 'txt' || extension === 'mmd' || extension === 'mermaid') return 'text/plain; charset=utf-8';
  if (extension === 'css') return 'text/css; charset=utf-8';
  if (extension === 'js') return 'text/javascript; charset=utf-8';
  if (extension === 'json') return 'application/json; charset=utf-8';
  if (extension === 'svg') return 'image/svg+xml; charset=utf-8';
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'ico') return 'image/x-icon';
  return 'application/octet-stream';
}

function isPublicArticleAssetRequest(pathname) {
  return pathname.endsWith('/favicon.svg') || pathname.endsWith('/favicon.ico');
}

function normalizePagePath(pathname) {
  if (pathname.endsWith('/index.html')) {
    return pathname.slice(0, -'index.html'.length);
  }
  if (!pathname.endsWith('/') && !pathExtension(pathname)) {
    return `${pathname}/`;
  }
  return pathname;
}

function pathExtension(pathname) {
  const lastSegment = pathname.split('/').pop() || '';
  const dotIndex = lastSegment.lastIndexOf('.');
  return dotIndex > 0 ? lastSegment.slice(dotIndex + 1) : '';
}

function getAuthPassword(env) {
  return String(env.ADMIN_PASSWORD || env.AUTH_PASSWORD || '');
}

async function getArticleSetting(env, path, article = null) {
  const stored = await getStoredArticleSetting(env, path);
  if (stored) return stored;

  const defaultEncrypted = Boolean(article?.encrypted);
  return {
    encrypted: defaultEncrypted,
    useAdminPassword: false,
    version: 'default',
    updatedAt: '',
  };
}

async function getStoredArticleSetting(env, path) {
  if (!env.SHARE_PAGES_CONFIG) return null;

  const raw = await env.SHARE_PAGES_CONFIG.get(articleSettingKey(path));
  if (!raw) return null;

  try {
    const setting = JSON.parse(raw);
    return {
      encrypted: Boolean(setting.encrypted),
      passwordCipher: typeof setting.passwordCipher === 'string' ? setting.passwordCipher : '',
      password: typeof setting.password === 'string' ? setting.password : '',
      useAdminPassword: Boolean(setting.useAdminPassword),
      version: typeof setting.version === 'string' ? setting.version : 'stored',
      updatedAt: typeof setting.updatedAt === 'string' ? setting.updatedAt : '',
    };
  } catch (error) {
    console.error('failed to parse article setting', { path, error });
    return null;
  }
}

async function putArticleSetting(env, path, setting) {
  if (!env.SHARE_PAGES_CONFIG) throw new Error('SHARE_PAGES_CONFIG KV binding is missing');
  await env.SHARE_PAGES_CONFIG.put(articleSettingKey(path), JSON.stringify(setting));
}

function articleSettingKey(path) {
  return `article:${path}`;
}

function wantsJson(request) {
  const accept = request.headers.get('Accept') || '';
  const requestedWith = request.headers.get('X-Requested-With') || '';
  const fetchMode = request.headers.get('Sec-Fetch-Mode') || '';
  return accept.includes('application/json') || requestedWith === 'fetch' || fetchMode === 'cors';
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

async function getArticlePassword(env, setting) {
  if (setting.passwordCipher) return decryptPassword(setting.passwordCipher, env);
  if (setting.password) return setting.password;
  if (setting.useAdminPassword) return getAuthPassword(env);
  return '';
}

async function getAdminArticleRows(env, catalog) {
  return Promise.all(catalog.map((article) => getArticleAdminRow(env, article)));
}

async function getArticleAdminRow(env, article) {
  const setting = await getArticleSetting(env, article.path);
  const password = await getArticlePassword(env, setting);
  return {
    ...article,
    encrypted: setting.encrypted,
    password,
    updatedAt: setting.updatedAt,
  };
}

function groupArticles(articles) {
  const projects = [];

  for (const article of articles) {
    let project = projects.find((item) => item.name === article.project);
    if (!project) {
      project = { name: article.project, categories: [] };
      projects.push(project);
    }

    let category = project.categories.find((item) => item.name === article.category);
    if (!category) {
      category = { name: article.category, articles: [] };
      project.categories.push(category);
    }

    category.articles.push(article);
  }

  return projects;
}

function newSettingVersion() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function encryptPassword(password, env) {
  const secret = getPasswordCryptoSecret(env);
  if (!secret) throw new Error('PASSWORD_CRYPTO_SECRET is missing');

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesKey(secret);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(password),
  );

  return `v1:${base64UrlEncodeBytes(iv)}:${base64UrlEncodeBytes(new Uint8Array(encrypted))}`;
}

async function decryptPassword(ciphertext, env) {
  if (!ciphertext.startsWith('v1:')) return '';

  const [, ivRaw, dataRaw] = ciphertext.split(':');
  const iv = base64UrlDecodeBytes(ivRaw);
  const data = base64UrlDecodeBytes(dataRaw);
  if (!iv || !data) return '';

  try {
    const key = await importAesKey(getPasswordCryptoSecret(env));
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new TextDecoder().decode(decrypted);
  } catch (error) {
    console.error('failed to decrypt article password', error);
    return '';
  }
}

function getPasswordCryptoSecret(env) {
  return String(env.PASSWORD_CRYPTO_SECRET || env.COOKIE_SIGNING_SECRET || env.COOKIE_SECRET || '');
}

async function importAesKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function getTurnstileSiteKey(env) {
  return String(env.TURNSTILE_SITE_KEY || '');
}

function isTurnstileEnabled(env) {
  return String(env.TURNSTILE_ENABLED || '').toLowerCase() === 'true';
}

async function verifyTurnstile(request, env, formData) {
  if (!isTurnstileEnabled(env)) return { ok: true };

  const secret = String(env.TURNSTILE_SECRET || '');
  const sitekey = getTurnstileSiteKey(env);

  if (!secret || !sitekey) {
    console.warn('turnstile configuration missing', {
      hasSecret: Boolean(secret),
      hasSitekey: Boolean(sitekey),
    });
    return { ok: false, error: '人机验证暂未配置完整，请稍后再试' };
  }

  const token = String(formData.get('cf-turnstile-response') || '');
  if (!token) return { ok: false, error: '请先完成 Cloudflare 验证' };
  if (token.length > 2048) return { ok: false, error: 'Cloudflare 验证无效，请刷新后重试' };

  const verifyForm = new FormData();
  verifyForm.append('secret', secret);
  verifyForm.append('response', token);

  const remoteIp = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '';
  if (remoteIp) verifyForm.append('remoteip', remoteIp);

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: verifyForm,
    });
    const result = await response.json();

    if (result.success) return { ok: true };

    console.warn('turnstile validation failed', {
      hostname: result.hostname,
      action: result.action,
      errors: result['error-codes'],
    });
    return { ok: false, error: 'Cloudflare 验证失败，请刷新后重试' };
  } catch (error) {
    console.error('turnstile validation error', error);
    return { ok: false, error: 'Cloudflare 验证失败，请稍后重试' };
  }
}

function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const pairs = cookie.split(';').map((part) => part.trim()).filter(Boolean);

  for (const pair of pairs) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    const key = pair.slice(0, index);
    const value = pair.slice(index + 1);
    if (key === name) return value;
  }

  return null;
}

async function isAdminAuthenticated(request, env) {
  return verifySignedCookie(getCookie(request, ADMIN_COOKIE), 'admin', env);
}

async function isArticleAuthenticated(request, env, path, setting) {
  return verifySignedCookie(getCookie(request, articleCookieName(path)), articleCookieValue(path, setting), env);
}

async function createSignedCookie(name, value, env, request) {
  const payload = base64UrlEncode(JSON.stringify({ value, issuedAt: Date.now() }));
  const signature = await sign(payload, env);
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${name}=${payload}.${signature}; Max-Age=${AUTH_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function clearCookie(name) {
  return `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure`;
}

async function verifySignedCookie(cookie, expectedValue, env) {
  if (!cookie) return false;
  const [payload, signature] = cookie.split('.');
  if (!payload || !signature) return false;

  const expectedSignature = await sign(payload, env);
  if (!constantTimeEqual(signature, expectedSignature)) return false;

  const decodedPayload = safeBase64UrlDecode(payload);
  if (!decodedPayload) return false;

  const { value, issuedAt } = parseCookiePayload(decodedPayload);
  if (value !== expectedValue || !Number.isFinite(issuedAt)) return false;

  return Date.now() - issuedAt < AUTH_TTL_SECONDS * 1000;
}

function parseCookiePayload(decodedPayload) {
  try {
    const parsed = JSON.parse(decodedPayload);
    return {
      value: String(parsed.value || ''),
      issuedAt: Number.parseInt(String(parsed.issuedAt || ''), 10),
    };
  } catch {
    const [value, issuedAtRaw] = decodedPayload.split(':');
    return {
      value,
      issuedAt: Number.parseInt(issuedAtRaw, 10),
    };
  }
}

async function sign(value, env) {
  const secret = String(env.COOKIE_SIGNING_SECRET || env.COOKIE_SECRET || env.ADMIN_PASSWORD || env.AUTH_PASSWORD || 'share-pages-dev-secret');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function articleCookieName(path) {
  return `share_page_${shortHash(path)}`;
}

function articleCookieValue(path, setting) {
  return `${path}:${setting.version || 'default'}`;
}

function shortHash(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index) | 0;
  }
  return Math.abs(hash).toString(36);
}

function base64UrlEncode(value) {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function safeBase64UrlDecode(value) {
  try {
    const bytes = base64UrlDecodeBytes(value);
    return bytes ? new TextDecoder().decode(bytes) : null;
  } catch {
    return null;
  }
}

function base64UrlDecodeBytes(value) {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return result === 0;
}

async function renderAdminPage(env, { catalog = [], notice = '', error = '' } = {}) {
  const articles = await getAdminArticleRows(env, catalog);
  const projects = groupArticles(articles);
  const noticeText = notice === 'saved' ? '设置已保存' : notice;
  const errorText = error === 'unknown-article' ? '没有找到这篇文章' : error;
  const initialToasts = [
    noticeText ? { type: 'success', message: noticeText } : null,
    errorText ? { type: 'error', message: errorText } : null,
    env.SHARE_PAGES_CONFIG ? null : { type: 'error', message: '存储绑定缺失，设置暂时无法保存。' },
    env.SHARE_PAGES_CONTENT ? null : { type: 'error', message: 'R2 内容绑定缺失，文章暂时无法读取。' },
  ].filter(Boolean);

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Share Pages</title>
    <link rel="icon" href="./favicon.svg" type="image/svg+xml" />
    <style>
      :root {
        color-scheme: light dark;
        --bg: #f7f8fb;
        --panel: #ffffff;
        --text: #17202a;
        --muted: #657282;
        --line: #d8dee8;
        --accent: #0f766e;
        --accent-soft: #d9f8f4;
        --danger: #b42318;
        --success: #117a4b;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0f1720;
          --panel: #162231;
          --text: #edf2f7;
          --muted: #aeb8c5;
          --line: #2c3a4a;
          --accent: #2dd4bf;
          --accent-soft: #113e3a;
          --danger: #ff7b72;
          --success: #70e0a3;
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family: Inter, "SF Pro Display", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
      }
      main {
        width: min(1120px, calc(100vw - 40px));
        margin: 42px auto 64px;
      }
      header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 20px;
        margin-bottom: 24px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 28px;
        letter-spacing: 0;
      }
      p {
        margin: 0;
        color: var(--muted);
        line-height: 1.7;
      }
      a {
        color: inherit;
      }
      .header-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        flex-wrap: wrap;
      }
      .tree-toolbar {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        padding: 3px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: var(--panel);
      }
      .tree-toggle,
      .logout {
        position: relative;
        display: grid;
        place-items: center;
        width: 34px;
        height: 34px;
        padding: 0;
        border: 0;
        border-radius: 999px;
        background: transparent;
        color: var(--muted);
        cursor: pointer;
        transition: background 160ms ease, color 160ms ease, transform 160ms ease;
      }
      .tree-toggle:hover,
      .logout:hover {
        background: var(--accent-soft);
        color: var(--accent);
        transform: translateY(-1px);
      }
      .tree-toggle svg,
      .logout svg {
        width: 18px;
        height: 18px;
        overflow: visible;
      }
      .tree-toggle .icon-state {
        transform-origin: center;
        transition: opacity 160ms ease, transform 180ms ease;
      }
      .tree-toggle[data-global-state="expanded"] .state-collapsed,
      .tree-toggle[data-global-state="collapsed"] .state-expanded {
        opacity: 0;
        transform: scale(0.72);
      }
      .tree-toggle .triangle {
        transition: transform 180ms ease;
      }
      .tree-toggle[data-global-state="expanded"]:hover .state-expanded .top-triangle {
        transform: translateY(1.5px);
      }
      .tree-toggle[data-global-state="expanded"]:hover .state-expanded .bottom-triangle {
        transform: translateY(-1.5px);
      }
      .tree-toggle[data-global-state="collapsed"]:hover .state-collapsed .top-triangle {
        transform: translateY(-1.5px);
      }
      .tree-toggle[data-global-state="collapsed"]:hover .state-collapsed .bottom-triangle {
        transform: translateY(1.5px);
      }
      .logout {
        text-decoration: none;
      }
      .toast-viewport {
        position: fixed;
        z-index: 20;
        top: 18px;
        right: 18px;
        display: grid;
        gap: 10px;
        width: min(340px, calc(100vw - 36px));
        pointer-events: none;
      }
      .toast {
        padding: 12px 14px;
        border: 1px solid var(--line);
        border-left: 4px solid var(--success);
        border-radius: 8px;
        background: var(--panel);
        color: var(--text);
        box-shadow: 0 12px 32px rgba(15, 23, 32, 0.14);
        font-size: 14px;
        line-height: 1.45;
        animation: toast-in 180ms ease-out both, toast-out 220ms ease-in forwards;
        animation-delay: 0ms, 3000ms;
      }
      .toast.error {
        border-left-color: var(--danger);
      }
      @keyframes toast-in {
        from {
          opacity: 0;
          transform: translateX(18px);
        }
        to {
          opacity: 1;
          transform: translateX(0);
        }
      }
      @keyframes toast-out {
        to {
          opacity: 0;
          transform: translateX(18px);
        }
      }
      .project {
        margin-top: 28px;
      }
      .project:first-of-type {
        margin-top: 18px;
      }
      .project-title {
        margin: 0 0 14px;
        font-size: 22px;
        letter-spacing: 0;
      }
      .category {
        margin-top: 22px;
      }
      .category:first-of-type {
        margin-top: 0;
      }
      .category-title {
        margin: 0 0 10px;
        color: var(--muted);
        font-size: 13px;
        font-weight: 800;
        letter-spacing: 0;
        text-transform: uppercase;
      }
      .collapse-heading {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .collapse-toggle {
        min-width: 0;
        max-width: 100%;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 4px 8px 4px 4px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: inherit;
        font: inherit;
        font-weight: inherit;
        letter-spacing: inherit;
        text-transform: inherit;
        cursor: pointer;
      }
      .collapse-toggle:hover {
        background: var(--accent-soft);
        color: var(--accent);
      }
      .chevron {
        position: relative;
        width: 16px;
        height: 16px;
        flex: 0 0 16px;
        color: currentColor;
        transition: transform 180ms ease;
      }
      .chevron::before {
        content: "";
        position: absolute;
        top: 3px;
        left: 5px;
        width: 0;
        height: 0;
        border-top: 5px solid transparent;
        border-bottom: 5px solid transparent;
        border-left: 6px solid currentColor;
      }
      .collapse-toggle[aria-expanded="true"] .chevron {
        transform: rotate(90deg);
      }
      .title-text {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .count-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 24px;
        height: 22px;
        padding: 0 8px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 12px;
        font-weight: 800;
        text-transform: none;
      }
      .collapse-panel {
        display: grid;
        grid-template-rows: 1fr;
        opacity: 1;
        transition: grid-template-rows 180ms ease, opacity 160ms ease;
      }
      .collapse-panel-inner {
        min-height: 0;
        overflow: hidden;
      }
      [data-collapse-group].is-collapsed > .collapse-panel {
        grid-template-rows: 0fr;
        opacity: 0;
      }
      .article-list {
        display: grid;
        gap: 10px;
      }
      .empty-state {
        margin-top: 22px;
        padding: 22px;
        border: 1px dashed var(--line);
        border-radius: 8px;
        background: var(--panel);
      }
      .empty-state strong {
        display: block;
        margin-bottom: 6px;
        font-size: 16px;
      }
      .row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: end;
        gap: 12px;
        padding: 14px 16px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
      }
      .row.is-saving {
        opacity: 0.72;
      }
      .row.is-saving .save,
      .row.is-saving .slider,
      .row.is-saving input {
        cursor: wait;
      }
      .meta {
        min-width: 0;
      }
      .title {
        display: block;
        margin-bottom: 8px;
        color: var(--text);
        font-size: 17px;
        font-weight: 700;
        text-decoration: none;
      }
      .path-line {
        display: flex;
        align-items: center;
        gap: 9px;
        min-width: 0;
      }
      code {
        color: var(--accent);
        font-size: 13px;
        line-height: 1.5;
        word-break: break-all;
      }
      .status {
        display: inline-flex;
        align-items: center;
        min-height: 24px;
        padding: 0 9px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 12px;
        font-weight: 700;
        white-space: nowrap;
      }
      .security-controls {
        display: grid;
        grid-template-rows: auto auto;
        justify-self: end;
        gap: 5px;
        width: 178px;
        padding: 6px 7px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: #fbfcfe;
      }
      .security-top,
      .security-bottom {
        display: grid;
        align-items: center;
        gap: 5px;
      }
      .security-top {
        grid-template-columns: auto minmax(0, 1fr);
      }
      .security-bottom {
        grid-template-columns: minmax(0, 1fr) 24px;
      }
      .switch-control {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        min-height: 18px;
        color: var(--muted);
        font-size: 10px;
        font-weight: 650;
        cursor: pointer;
      }
      .switch-label {
        line-height: 1;
      }
      .switch {
        position: relative;
        display: inline-flex;
        align-items: center;
        width: 25px;
        height: 14px;
        flex: 0 0 25px;
      }
      .switch input {
        position: absolute;
        opacity: 0;
      }
      .slider {
        width: 25px;
        height: 14px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: transparent;
        cursor: pointer;
        transition: background 160ms ease, border-color 160ms ease;
      }
      .slider::before {
        content: "";
        position: absolute;
        top: 3px;
        left: 3px;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--muted);
        transition: transform 160ms ease, background 160ms ease;
      }
      .switch input:checked + .slider {
        border-color: var(--accent);
        background: var(--accent);
      }
      .switch input:checked + .slider::before {
        transform: translateX(11px);
        background: #fff;
      }
      .password-wrap {
        position: relative;
      }
      .password-wrap label {
        position: absolute;
        left: 7px;
        top: -5px;
        z-index: 1;
        padding: 0 3px;
        background: #fbfcfe;
        color: var(--muted);
        font-size: 9px;
        font-weight: 650;
        line-height: 1;
      }
      input[type="password"],
      input[type="text"] {
        width: 100%;
        height: 22px;
        padding: 0 22px 0 7px;
        border: 1px solid var(--line);
        border-radius: 4px;
        background: transparent;
        color: var(--text);
        font: inherit;
        font-size: 10px;
      }
      .icon-button {
        position: absolute;
        right: 2px;
        bottom: 2px;
        width: 18px;
        height: 18px;
        display: grid;
        place-items: center;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--muted);
        cursor: pointer;
      }
      .icon-button:hover {
        color: var(--accent);
        background: var(--accent-soft);
      }
      .save {
        position: relative;
        display: grid;
        place-items: center;
        width: 24px;
        height: 22px;
        padding: 0;
        border: 0;
        border-radius: 4px;
        background: var(--accent);
        color: #fff;
        font: inherit;
        cursor: pointer;
        transition: background 160ms ease, transform 160ms ease;
      }
      .save:hover {
        background: #0f766e;
      }
      .save:hover::after,
      .save:focus-visible::after {
        content: attr(aria-label);
        position: absolute;
        right: 0;
        bottom: calc(100% + 5px);
        padding: 3px 6px;
        border-radius: 4px;
        background: var(--text);
        color: #fff;
        font-size: 11px;
        line-height: 1;
        white-space: nowrap;
        box-shadow: 0 8px 18px rgba(15, 23, 42, 0.16);
      }
      .save-icon {
        width: 13px;
        height: 13px;
      }
      .row.is-saving .save-icon {
        animation: save-pulse 700ms ease-in-out infinite;
      }
      @keyframes save-pulse {
        0%, 100% {
          transform: scale(1);
          opacity: 1;
        }
        50% {
          transform: scale(0.82);
          opacity: 0.62;
        }
      }
      .hint {
        min-width: 0;
        overflow: hidden;
        text-align: right;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--muted);
        font-size: 9px;
        line-height: 1.1;
      }
      @media (max-width: 820px) {
        main {
          width: min(100vw - 24px, 720px);
          margin-top: 26px;
        }
        .row {
          grid-template-columns: minmax(0, 1fr) auto;
          align-items: end;
        }
        header {
          display: block;
        }
        .header-actions {
          justify-content: flex-start;
          margin-top: 14px;
        }
        .tree-toolbar {
          width: auto;
        }
        .meta {
          grid-column: 1 / -1;
          margin-bottom: 0;
        }
        .security-controls {
          grid-column: 2;
          width: 168px;
          margin-top: -3px;
          padding: 6px 7px;
        }
        .security-bottom {
          grid-template-columns: minmax(0, 1fr) 24px;
        }
        .save {
          width: 24px;
        }
      }
    </style>
  </head>
  <body>
    <div class="toast-viewport" aria-live="polite" aria-atomic="true"></div>
    <main>
      <header>
        <div>
          <h1>Share Pages</h1>
          <p>团队 HTML 文档入口。这里按项目和分类组织文档，每篇文章可单独配置访问密码和加密状态。</p>
        </div>
        <div class="header-actions">
          ${renderHeaderControls(Boolean(projects.length))}
        </div>
      </header>
      ${projects.length ? projects.map(renderProjectSection).join('') : renderEmptyState()}
    </main>
    <script>
      const initialToasts = ${jsonForScript(initialToasts)};
      const toastViewport = document.querySelector('.toast-viewport');
      const showToast = (message, type = 'success') => {
        if (!message) return;
        const toast = document.createElement('div');
        toast.className = type === 'error' ? 'toast error' : 'toast';
        toast.textContent = message;
        toastViewport.appendChild(toast);
        window.setTimeout(() => toast.remove(), 3300);
      };
      initialToasts.forEach((toast) => showToast(toast.message, toast.type));

      const collapseStorageKey = 'share-pages-admin-collapse-v1';
      const collapseGroups = Array.from(document.querySelectorAll('[data-collapse-group]'));
      const readCollapseState = () => {
        try {
          const parsed = JSON.parse(window.localStorage.getItem(collapseStorageKey) || '{}');
          return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
          return {};
        }
      };
      const writeCollapseState = () => {
        const state = {};
        collapseGroups.forEach((group) => {
          if (group.classList.contains('is-collapsed')) {
            state[group.dataset.collapseKey] = true;
          }
        });
        try {
          window.localStorage.setItem(collapseStorageKey, JSON.stringify(state));
        } catch {
          // Collapse still works even if the browser blocks localStorage.
        }
      };
      const directChild = (element, selector) => (
        Array.from(element.children).find((child) => child.matches(selector))
      );
      const setGroupCollapsed = (group, collapsed, persist = true) => {
        const heading = directChild(group, '.collapse-heading');
        const button = heading ? heading.querySelector('[data-collapse-toggle]') : null;
        const panel = directChild(group, '[data-collapse-panel]');
        if (!button || !panel) return;

        group.classList.toggle('is-collapsed', collapsed);
        button.setAttribute('aria-expanded', String(!collapsed));
        button.setAttribute('title', collapsed ? '展开' : '收起');
        panel.setAttribute('aria-hidden', String(collapsed));
        panel.inert = collapsed;

        if (persist) writeCollapseState();
      };
      const collapseState = readCollapseState();
      const globalCollapseToggle = document.querySelector('[data-collapse-toggle-all]');
      const updateGlobalCollapseToggle = () => {
        if (!globalCollapseToggle) return;
        const allCollapsed = collapseGroups.length > 0 && collapseGroups.every((group) => (
          group.classList.contains('is-collapsed')
        ));
        const label = allCollapsed ? '一键展开全部' : '一键收起全部';
        globalCollapseToggle.dataset.globalState = allCollapsed ? 'collapsed' : 'expanded';
        globalCollapseToggle.setAttribute('aria-label', label);
        globalCollapseToggle.setAttribute('title', label);
      };
      collapseGroups.forEach((group) => {
        setGroupCollapsed(group, Boolean(collapseState[group.dataset.collapseKey]), false);
        const heading = directChild(group, '.collapse-heading');
        const button = heading ? heading.querySelector('[data-collapse-toggle]') : null;
        if (!button) return;

        button.addEventListener('click', () => {
          setGroupCollapsed(group, !group.classList.contains('is-collapsed'));
          updateGlobalCollapseToggle();
        });
      });
      if (globalCollapseToggle) {
        globalCollapseToggle.addEventListener('click', () => {
          const shouldCollapse = globalCollapseToggle.dataset.globalState !== 'collapsed';
          collapseGroups.forEach((group) => setGroupCollapsed(group, shouldCollapse, false));
          writeCollapseState();
          updateGlobalCollapseToggle();
        });
        updateGlobalCollapseToggle();
      }

      const statusText = (encrypted) => encrypted ? '已加密' : '公开';
      const formatBeijingDateTime = (value) => {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value).replace(/^上次更新：/, '');
        const parts = new Intl.DateTimeFormat('zh-CN', {
          timeZone: 'Asia/Shanghai',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }).formatToParts(date).reduce((acc, part) => {
          if (part.type !== 'literal') acc[part.type] = part.value;
          return acc;
        }, {});
        return \`\${parts.year}-\${parts.month}-\${parts.day} \${parts.hour}:\${parts.minute}:\${parts.second}\`;
      };
      const hintText = (updatedAt) => formatBeijingDateTime(updatedAt) || '未保存';
      const setFormSaving = (form, saving) => {
        form.closest('.row').classList.toggle('is-saving', saving);
        form.querySelectorAll('button, input').forEach((control) => {
          if (control.matches('[data-toggle-password]')) return;
          control.disabled = saving;
        });
      };
      const updateRow = (form, article) => {
        const row = form.closest('.row');
        const checkbox = form.querySelector('[data-encrypted-toggle]');
        const passwordInput = form.querySelector('input[name="password"]');
        const status = row.querySelector('.status');
        const hint = form.querySelector('.hint');
        checkbox.checked = Boolean(article.encrypted);
        checkbox.dataset.lastChecked = String(checkbox.checked);
        passwordInput.value = article.password || '';
        passwordInput.dataset.savedPassword = article.password || '';
        status.textContent = statusText(Boolean(article.encrypted));
        hint.textContent = hintText(article.updatedAt || '');
      };
      const submitArticleSetting = async (form, action, successMessage) => {
        const formData = new FormData(form);
        formData.set('action', action);
        const actionUrl = new URL(form.getAttribute('action') || '/admin/article', window.location.href);
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 10000);
        setFormSaving(form, true);
        try {
          const response = await fetch(actionUrl.toString(), {
            method: 'POST',
            redirect: 'manual',
            headers: {
              Accept: 'application/json',
              'X-Requested-With': 'fetch',
            },
            body: formData,
            signal: controller.signal,
          });
          const contentType = response.headers.get('content-type') || '';
          if (response.type === 'opaqueredirect' || response.status === 0) {
            throw new Error('请重新登录后再保存');
          }
          if (!contentType.includes('application/json')) {
            throw new Error(response.ok ? '请重新登录后再保存' : '设置保存失败');
          }
          const result = await response.json().catch(() => ({}));
          if (!response.ok || !result.ok) {
            throw new Error(result.error || '设置保存失败');
          }
          updateRow(form, result.article);
          showToast(successMessage || result.notice || '设置已保存');
        } catch (error) {
          if (error.name === 'AbortError') throw new Error('保存超时，请重试');
          throw error;
        } finally {
          window.clearTimeout(timeout);
          setFormSaving(form, false);
        }
      };

      document.querySelectorAll('[data-toggle-password]').forEach((button) => {
        button.addEventListener('click', () => {
          const input = button.closest('.password-wrap').querySelector('input');
          const showing = input.type === 'text';
          input.type = showing ? 'password' : 'text';
          button.setAttribute('aria-pressed', String(!showing));
        });
      });
      document.querySelectorAll('form[data-article-form]').forEach((form) => {
        const checkbox = form.querySelector('[data-encrypted-toggle]');
        const passwordInput = form.querySelector('input[name="password"]');
        checkbox.dataset.lastChecked = String(checkbox.checked);
        passwordInput.dataset.savedPassword = passwordInput.value || '';

        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          try {
            const nextMessage = passwordInput.value.trim() ? '密码已设置' : '密码已清空';
            await submitArticleSetting(form, 'password', nextMessage);
          } catch (error) {
            showToast(error.message, 'error');
          }
        });

        checkbox.addEventListener('change', async () => {
          const nextChecked = checkbox.checked;
          const previousChecked = checkbox.dataset.lastChecked === 'true';

          if (nextChecked && !passwordInput.value.trim()) {
            checkbox.checked = previousChecked;
            showToast('请先设置密码', 'error');
            return;
          }

          try {
            await submitArticleSetting(
              form,
              nextChecked ? 'encrypt' : 'decrypt',
              nextChecked ? '文章已加密' : '文章已解除加密',
            );
          } catch (error) {
            checkbox.checked = previousChecked;
            showToast(error.message, 'error');
          }
        });
      });
    </script>
  </body>
</html>`;
}

function renderProjectSection(project) {
  const key = `project:${project.name}`;
  const hash = shortHash(key);
  const panelId = `project-panel-${hash}`;
  const articleCount = project.categories.reduce((total, category) => total + category.articles.length, 0);

  return `<section class="project" data-collapse-group data-collapse-level="1" data-collapse-key="${escapeHtml(key)}" aria-labelledby="project-${hash}">
    <h2 id="project-${hash}" class="project-title collapse-heading">
      ${renderCollapseButton({
        label: project.name,
        count: articleCount,
        panelId,
        levelLabel: '项目',
      })}
    </h2>
    <div id="${panelId}" class="collapse-panel" data-collapse-panel>
      <div class="collapse-panel-inner">
        ${project.categories.map((category) => renderCategorySection(category, project.name)).join('')}
      </div>
    </div>
  </section>`;
}

function renderCategorySection(category, projectName) {
  const key = `category:${projectName}:${category.name}`;
  const hash = shortHash(key);
  const panelId = `category-panel-${hash}`;

  return `<section class="category" data-collapse-group data-collapse-level="2" data-collapse-key="${escapeHtml(key)}" aria-labelledby="category-${hash}">
    <h3 id="category-${hash}" class="category-title collapse-heading">
      ${renderCollapseButton({
        label: category.name,
        count: category.articles.length,
        panelId,
        levelLabel: '分类',
      })}
    </h3>
    <div id="${panelId}" class="collapse-panel" data-collapse-panel>
      <div class="collapse-panel-inner">
        <div class="article-list">
          ${category.articles.map(renderArticleManagerRow).join('')}
        </div>
      </div>
    </div>
  </section>`;
}

function renderHeaderControls(hasProjects) {
  return `<div class="tree-toolbar" aria-label="目录展开控制">
    ${hasProjects ? `<button class="tree-toggle" type="button" data-collapse-toggle-all data-global-state="expanded" aria-label="一键收起全部" title="一键收起全部">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <g class="icon-state state-expanded">
          <path class="triangle top-triangle" d="M7.5 7.5 12 10.7 16.5 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path class="triangle bottom-triangle" d="M7.5 16.5 12 13.3 16.5 16.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </g>
        <g class="icon-state state-collapsed">
          <path class="triangle top-triangle" d="M7.5 10 12 6.8 16.5 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path class="triangle bottom-triangle" d="M7.5 14 12 17.2 16.5 14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </g>
      </svg>
    </button>` : ''}
    <a class="logout" href="/logout" aria-label="退出" title="退出">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M9 5H6.8A1.8 1.8 0 0 0 5 6.8v10.4A1.8 1.8 0 0 0 6.8 19H9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <path d="M13 8l4 4-4 4M17 12H9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </a>
  </div>`;
}

function renderCollapseButton({ label, count, panelId, levelLabel }) {
  return `<button class="collapse-toggle" type="button" data-collapse-toggle aria-expanded="true" aria-controls="${escapeHtml(panelId)}" title="收起">
    <span class="chevron" aria-hidden="true"></span>
    <span class="title-text">${escapeHtml(label)}</span>
    <span class="count-badge" aria-label="${escapeHtml(levelLabel)}下共有 ${count} 篇文章">${count}</span>
  </button>`;
}

function renderEmptyState() {
  return `<section class="empty-state" aria-label="No documents">
    <strong>还没有文档</strong>
    <p>使用导入脚本上传 HTML 后，目录会自动从 Cloudflare KV 中读取。</p>
  </section>`;
}

function renderArticleManagerRow(article) {
  const checked = article.encrypted ? ' checked' : '';
  const status = article.encrypted ? '已加密' : '公开';
  const password = article.password;
  const updatedAt = formatBeijingDateTime(article.updatedAt) || '未保存';

  return `<article class="row">
    <div class="meta">
      <a class="title" href="${escapeHtml(article.path)}">${escapeHtml(article.title)}</a>
      <div class="path-line">
        <code>${escapeHtml(article.path)}</code>
        <span class="status">${status}</span>
      </div>
    </div>
    <form class="security-controls" data-article-form method="post" action="/admin/article" autocomplete="off">
      <input type="hidden" name="path" value="${escapeHtml(article.path)}" />
      <input type="hidden" name="action" value="password" />
      <div class="security-top">
        <label class="switch-control" for="encrypted-${shortHash(article.path)}">
          <span class="switch-label">加密</span>
          <span class="switch">
            <input id="encrypted-${shortHash(article.path)}" data-encrypted-toggle type="checkbox" name="encrypted"${checked} />
            <span class="slider"></span>
          </span>
        </label>
        <div class="hint">${updatedAt}</div>
      </div>
      <div class="security-bottom">
        <div class="password-wrap">
          <label for="password-${shortHash(article.path)}">设置密码</label>
          <input id="password-${shortHash(article.path)}" name="password" type="password" value="${escapeHtml(password)}" autocomplete="off" />
          <button class="icon-button" type="button" data-toggle-password aria-label="查看密码" title="查看密码" aria-pressed="false">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              <circle cx="12" cy="12" r="2.6" stroke="currentColor" stroke-width="1.8"/>
            </svg>
          </button>
        </div>
        <button class="save" type="submit" aria-label="保存" title="保存">
          <svg class="save-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 4h11l3 3v13H5V4Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
            <path d="M8 4v6h8V4M8 20v-6h8v6" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    </form>
  </article>`;
}

function formatBeijingDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).replace(/^上次更新：/, '');
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function renderLoginPage({ mode, path = '/', title = 'Share Pages Admin', error = '', turnstileSiteKey = '' }) {
  const isArticle = mode === 'article';
  const action = isArticle ? '/unlock' : '/login';
  const description = isArticle
    ? '这篇文档已加密，请输入访问密码。'
    : '请输入管理员密码进入团队文档入口。';
  const turnstileWidget = turnstileSiteKey
    ? `<div class="turnstile"><div class="cf-turnstile" data-sitekey="${escapeHtml(turnstileSiteKey)}" data-theme="auto"></div></div>`
    : '';

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    ${turnstileSiteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}
    <style>
      :root {
        color-scheme: light dark;
        --bg: #f7f8fb;
        --panel: #ffffff;
        --text: #17202a;
        --muted: #657282;
        --line: #d8dee8;
        --accent: #0f766e;
        --danger: #b42318;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0f1720;
          --panel: #162231;
          --text: #edf2f7;
          --muted: #aeb8c5;
          --line: #2c3a4a;
          --accent: #2dd4bf;
          --danger: #ff7b72;
        }
      }
      body {
        min-height: 100vh;
        margin: 0;
        display: grid;
        place-items: center;
        background: var(--bg);
        color: var(--text);
        font-family: Inter, "SF Pro Display", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
      }
      main {
        width: min(420px, calc(100vw - 40px));
        padding: 30px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
      }
      h1 {
        margin: 0 0 10px;
        font-size: 25px;
      }
      p {
        margin: 0 0 22px;
        color: var(--muted);
        line-height: 1.7;
      }
      label {
        display: block;
        margin-bottom: 8px;
        color: var(--muted);
        font-size: 14px;
      }
      input {
        width: 100%;
        box-sizing: border-box;
        padding: 12px 13px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: transparent;
        color: var(--text);
        font: inherit;
      }
      button {
        width: 100%;
        margin-top: 16px;
        padding: 12px 14px;
        border: 0;
        border-radius: 6px;
        background: var(--accent);
        color: #fff;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }
      .turnstile {
        min-height: 65px;
        margin-top: 16px;
        overflow: hidden;
      }
      .error {
        margin-bottom: 14px;
        color: var(--danger);
        font-size: 14px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(description)}</p>
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
      <form method="post" action="${action}">
        ${isArticle ? `<input type="hidden" name="path" value="${escapeHtml(path)}" />` : ''}
        <label for="password">访问密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
        ${turnstileWidget}
        <button type="submit">${isArticle ? '查看文档' : '进入入口'}</button>
      </form>
    </main>
  </body>
</html>`;
}

function renderErrorPage(message = '服务暂时不可用') {
  return `<!doctype html><meta charset="utf-8"><title>错误</title><p>${escapeHtml(message)}</p>`;
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function htmlResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
  });
}

function redirect(location, headers = {}) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      ...headers,
    },
  });
}
