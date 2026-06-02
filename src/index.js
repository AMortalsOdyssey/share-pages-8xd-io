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
  const key = articleObjectKey(article, new URL(request.url).pathname);
  if (!key) return htmlResponse(renderErrorPage('页面不存在'), 404);

  const bucket = getContentBucket(env);
  const object = await bucket.get(key);
  if (!object) return htmlResponse(renderErrorPage('页面不存在'), 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', contentTypeForKey(key));
  headers.set('Cache-Control', key.endsWith('/index.html') ? 'no-store' : 'public, max-age=3600');

  return new Response(request.method === 'HEAD' ? null : object.body, {
    status: 200,
    headers,
  });
}

function articleObjectKey(article, pathname) {
  const suffix = articleAssetPath(article, pathname);
  if (!suffix || suffix.includes('..') || suffix.startsWith('/')) return '';
  if (suffix === 'index.html') return article.r2Key;
  if (suffix === 'favicon.svg' && article.faviconKey) return article.faviconKey;
  if (!article.r2Prefix) return '';
  return `${article.r2Prefix.replace(/\/?$/, '/')}${suffix}`;
}

function getContentBucket(env) {
  if (!env.SHARE_PAGES_CONTENT) throw new Error('SHARE_PAGES_CONTENT R2 binding is missing');
  return env.SHARE_PAGES_CONTENT;
}

function contentTypeForKey(key) {
  const extension = pathExtension(key).toLowerCase();
  if (extension === 'html') return 'text/html; charset=utf-8';
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
      .logout {
        display: inline-flex;
        align-items: center;
        min-height: 36px;
        padding: 0 12px;
        border: 1px solid var(--line);
        border-radius: 6px;
        color: var(--muted);
        text-decoration: none;
        white-space: nowrap;
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
        grid-template-columns: minmax(0, 1fr) minmax(300px, 370px);
        gap: 16px;
        padding: 16px 18px;
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
      form {
        display: grid;
        grid-template-columns: 52px minmax(0, 1fr) 64px;
        align-items: end;
        gap: 10px;
        width: 100%;
      }
      label {
        display: block;
        margin-bottom: 7px;
        color: var(--muted);
        font-size: 13px;
      }
      .switch-label {
        margin-bottom: 7px;
      }
      .switch {
        position: relative;
        display: inline-flex;
        align-items: center;
        width: 48px;
        height: 28px;
      }
      .switch input {
        position: absolute;
        opacity: 0;
      }
      .slider {
        width: 48px;
        height: 28px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: transparent;
        cursor: pointer;
        transition: background 160ms ease, border-color 160ms ease;
      }
      .slider::before {
        content: "";
        position: absolute;
        top: 4px;
        left: 4px;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: var(--muted);
        transition: transform 160ms ease, background 160ms ease;
      }
      .switch input:checked + .slider {
        border-color: var(--accent);
        background: var(--accent);
      }
      .switch input:checked + .slider::before {
        transform: translateX(20px);
        background: #fff;
      }
      .password-wrap {
        position: relative;
      }
      input[type="password"],
      input[type="text"] {
        width: 100%;
        height: 38px;
        padding: 0 42px 0 11px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: transparent;
        color: var(--text);
        font: inherit;
      }
      .icon-button {
        position: absolute;
        right: 4px;
        bottom: 4px;
        width: 30px;
        height: 30px;
        display: grid;
        place-items: center;
        border: 0;
        border-radius: 5px;
        background: transparent;
        color: var(--muted);
        cursor: pointer;
      }
      .icon-button:hover {
        color: var(--accent);
        background: var(--accent-soft);
      }
      .save {
        height: 38px;
        padding: 0 14px;
        border: 0;
        border-radius: 6px;
        background: var(--accent);
        color: #fff;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
        white-space: nowrap;
      }
      .hint {
        grid-column: 1 / -1;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.5;
      }
      @media (max-width: 820px) {
        main {
          width: min(100vw - 24px, 720px);
          margin-top: 26px;
        }
        header,
        .row {
          display: block;
        }
        .meta {
          margin-bottom: 16px;
        }
        form {
          grid-template-columns: 1fr;
        }
        .save {
          width: 100%;
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
        <a class="logout" href="/logout">退出</a>
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

      const statusText = (encrypted) => encrypted ? '已加密' : '公开';
      const hintText = (updatedAt) => updatedAt ? \`上次更新：\${updatedAt}\` : '尚未单独保存设置';
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
  return `<section class="project" aria-labelledby="project-${shortHash(project.name)}">
    <h2 id="project-${shortHash(project.name)}" class="project-title">${escapeHtml(project.name)}</h2>
    ${project.categories.map(renderCategorySection).join('')}
  </section>`;
}

function renderCategorySection(category) {
  return `<section class="category" aria-label="${escapeHtml(category.name)}">
    <h3 class="category-title">${escapeHtml(category.name)}</h3>
    <div class="article-list">
      ${category.articles.map(renderArticleManagerRow).join('')}
    </div>
  </section>`;
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
  const updatedAt = article.updatedAt ? `上次更新：${escapeHtml(article.updatedAt)}` : '尚未单独保存设置';

  return `<article class="row">
    <div class="meta">
      <a class="title" href="${escapeHtml(article.path)}">${escapeHtml(article.title)}</a>
      <div class="path-line">
        <code>${escapeHtml(article.path)}</code>
        <span class="status">${status}</span>
      </div>
    </div>
    <form data-article-form method="post" action="/admin/article" autocomplete="off">
      <input type="hidden" name="path" value="${escapeHtml(article.path)}" />
      <input type="hidden" name="action" value="password" />
      <div>
        <label class="switch-label" for="encrypted-${shortHash(article.path)}">加密</label>
        <label class="switch">
          <input id="encrypted-${shortHash(article.path)}" data-encrypted-toggle type="checkbox" name="encrypted"${checked} />
          <span class="slider"></span>
        </label>
      </div>
      <div class="password-wrap">
        <label for="password-${shortHash(article.path)}">独立密码</label>
        <input id="password-${shortHash(article.path)}" name="password" type="password" value="${escapeHtml(password)}" autocomplete="off" />
        <button class="icon-button" type="button" data-toggle-password aria-label="查看密码" title="查看密码" aria-pressed="false">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            <circle cx="12" cy="12" r="2.6" stroke="currentColor" stroke-width="1.8"/>
          </svg>
        </button>
      </div>
      <button class="save" type="submit">保存</button>
      <div class="hint">${updatedAt}</div>
    </form>
  </article>`;
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
