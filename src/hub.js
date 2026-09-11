const SHORT_LINK_PREFIXES = ['/s/', '/go/'];
const HUB_PATH = '/hub';
const HUB_API_PREFIX = '/api/hub';
const DEFAULT_MONITOR_TIMEOUT_MS = 8000;
const MAX_EMAIL_BYTES = 10 * 1024 * 1024;

export function isHubPublicPath(pathname) {
  return SHORT_LINK_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function isHubAdminPath(pathname) {
  return pathname === HUB_PATH || pathname.startsWith(`${HUB_API_PREFIX}/`) || pathname === HUB_API_PREFIX;
}

export async function handleHubPublicRequest(request, env, ctx, ui) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/(?:s|go)\/([^/]+)\/?$/);

  if (!match || request.method !== 'GET') {
    return ui.htmlResponse(renderHubError('短链不存在'), 404);
  }

  const slug = normalizeSlug(match[1]);
  if (!slug) return ui.htmlResponse(renderHubError('短链不存在'), 404);

  const link = await getShortLink(env, slug);
  if (!link || !link.enabled || isExpired(link.expires_at)) {
    return ui.htmlResponse(renderHubError('短链不存在或已过期'), 404);
  }

  const event = buildRequestEvent(request, {
    eventType: 'shortlink_redirect',
    resourceType: 'short_link',
    resourceId: slug,
  });

  ctx?.waitUntil?.(recordHubEvent(env, event));
  ctx?.waitUntil?.(markShortLinkClicked(env, slug, event.occurredAt));

  return new Response(null, {
    status: 302,
    headers: {
      Location: link.target_url,
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}

export async function handleHubAdminRequest(request, env, ctx, ui) {
  const url = new URL(request.url);

  try {
    if (url.pathname === HUB_PATH && request.method === 'GET') {
      const summary = await getHubSummary(env);
      const csrfToken = ui.createAdminCsrfToken ? await ui.createAdminCsrfToken() : '';
      return ui.htmlResponse(renderHubPage(summary, {
        csrfToken,
        notice: url.searchParams.get('notice') || '',
        error: url.searchParams.get('error') || '',
      }));
    }

    if (url.pathname === `${HUB_API_PREFIX}/summary` && request.method === 'GET') {
      return ui.jsonResponse({ ok: true, summary: await getHubSummary(env) });
    }

    if (url.pathname === `${HUB_API_PREFIX}/links` && request.method === 'GET') {
      return ui.jsonResponse({ ok: true, links: await listShortLinks(env, 100) });
    }

    if (url.pathname === `${HUB_API_PREFIX}/links` && request.method === 'POST') {
      const data = await readRequestData(request);
      const csrf = await verifyHubMutation(ui, data.formData);
      if (!csrf.ok) return ui.jsonResponse({ ok: false, error: csrf.error }, 403);
      const link = await createShortLink(env, data.values);
      return ui.jsonResponse({ ok: true, link });
    }

    const linkMatch = url.pathname.match(/^\/api\/hub\/links\/([^/]+)$/);
    if (linkMatch && request.method === 'POST') {
      const data = await readRequestData(request);
      const csrf = await verifyHubMutation(ui, data.formData);
      if (!csrf.ok) return ui.jsonResponse({ ok: false, error: csrf.error }, 403);
      const slug = normalizeSlug(linkMatch[1]);
      const action = String(data.values.action || 'toggle');
      const link = await updateShortLinkState(env, slug, action);
      return ui.jsonResponse({ ok: true, link });
    }

    if (url.pathname === `${HUB_API_PREFIX}/monitors` && request.method === 'GET') {
      return ui.jsonResponse({ ok: true, monitors: await listMonitorTargets(env, { includeEnvTargets: true }) });
    }

    if (url.pathname === `${HUB_API_PREFIX}/monitors` && request.method === 'POST') {
      const data = await readRequestData(request);
      const csrf = await verifyHubMutation(ui, data.formData);
      if (!csrf.ok) return ui.jsonResponse({ ok: false, error: csrf.error }, 403);
      const target = await createMonitorTarget(env, data.values);
      return ui.jsonResponse({ ok: true, target });
    }

    const monitorActionMatch = url.pathname.match(/^\/api\/hub\/monitors\/([^/]+)$/);
    if (monitorActionMatch && request.method === 'POST') {
      const data = await readRequestData(request);
      const csrf = await verifyHubMutation(ui, data.formData);
      if (!csrf.ok) return ui.jsonResponse({ ok: false, error: csrf.error }, 403);
      const action = String(data.values.action || 'toggle');
      const target = await updateMonitorTargetState(env, monitorActionMatch[1], action);
      return ui.jsonResponse({ ok: true, target });
    }

    const monitorCheckMatch = url.pathname.match(/^\/api\/hub\/monitors\/([^/]+)\/check$/);
    if (monitorCheckMatch && request.method === 'POST') {
      const data = await readRequestData(request);
      const csrf = await verifyHubMutation(ui, data.formData);
      if (!csrf.ok) return ui.jsonResponse({ ok: false, error: csrf.error }, 403);
      const result = await checkMonitorById(env, monitorCheckMatch[1]);
      return ui.jsonResponse({ ok: true, result });
    }

    if (url.pathname === `${HUB_API_PREFIX}/mail` && request.method === 'GET') {
      return ui.jsonResponse({ ok: true, mail: await listInboundEmails(env, 50) });
    }

    return ui.jsonResponse({ ok: false, error: 'Hub route not found' }, 404);
  } catch (error) {
    console.error('hub admin request failed', {
      pathname: url.pathname,
      method: request.method,
      error,
    });
    const message = humanHubError(error);
    if (wantsJson(request) || url.pathname.startsWith('/api/')) {
      return ui.jsonResponse({ ok: false, error: message }, error.status || 500);
    }

    const summary = await getHubSummary(env).catch(() => emptyHubSummary());
    const csrfToken = ui.createAdminCsrfToken ? await ui.createAdminCsrfToken() : '';
    return ui.htmlResponse(renderHubPage(summary, { csrfToken, error: message }), error.status || 500);
  }
}

export async function handleHubScheduled(controller, env, ctx) {
  const targets = await listMonitorTargets(env, { includeEnvTargets: true, enabledOnly: true });
  if (!targets.length) {
    console.info('hub scheduled monitor skipped: no enabled targets');
    return;
  }

  console.info('hub scheduled monitor started', {
    scheduledTime: controller?.scheduledTime,
    targetCount: targets.length,
  });

  const checks = targets.map((target) => runMonitorCheck(env, target, {
    source: 'scheduled',
    scheduledTime: controller?.scheduledTime,
  }));
  await Promise.allSettled(checks);

  ctx?.waitUntil?.(recordHubEvent(env, {
    eventType: 'monitor_batch',
    resourceType: 'monitor',
    resourceId: 'scheduled',
    occurredAt: utcNow(),
    country: '',
    referrerHost: '',
    userAgentFamily: 'cron',
  }));
}

export async function handleHubQueue(batch, env) {
  const messages = Array.isArray(batch?.messages) ? batch.messages : [];
  console.info('hub queue batch received', { messageCount: messages.length });

  for (const message of messages) {
    try {
      await recordHubEventDirect(env, normalizeQueuedEvent(message.body));
    } catch (error) {
      console.error('hub queue message failed', { error });
      throw error;
    }
  }
}

export async function handleHubEmail(message, env, ctx) {
  const maxBytes = parseInteger(env.HUB_EMAIL_MAX_BYTES, MAX_EMAIL_BYTES);
  if (message.rawSize && message.rawSize > maxBytes) {
    console.warn('hub email rejected: message too large', {
      from: maskEmail(message.from),
      to: maskEmail(message.to),
      rawSize: message.rawSize,
      maxBytes,
    });
    message.setReject?.('Message too large');
    return;
  }

  const result = await storeInboundEmail(message, env);
  ctx?.waitUntil?.(recordHubEvent(env, {
    eventType: 'email_received',
    resourceType: 'email',
    resourceId: result.id,
    occurredAt: result.receivedAt,
    country: '',
    referrerHost: '',
    userAgentFamily: 'email',
  }));

  const forwardTo = String(env.HUB_MAIL_FORWARD_TO || '').trim();
  if (forwardTo) {
    console.info('hub email forwarding', {
      id: result.id,
      to: maskEmail(forwardTo),
    });
    await message.forward(forwardTo);
  }
}

async function getHubSummary(env) {
  const dbReady = Boolean(env.HUB_DB);
  const [links, monitors, mail, eventRows] = await Promise.all([
    dbReady ? listShortLinks(env, 25) : [],
    dbReady ? listMonitorTargets(env, { includeEnvTargets: true }) : parseEnvMonitorTargets(env),
    dbReady ? listInboundEmails(env, 12) : [],
    dbReady ? listEventDaily(env, 14) : [],
  ]);

  return {
    dbReady,
    queueReady: Boolean(env.HUB_EVENTS),
    mailboxReady: Boolean(env.HUB_MAILBOX),
    analyticsReady: Boolean(env.HUB_ANALYTICS),
    monitorEnvTargets: parseEnvMonitorTargets(env).length,
    totals: dbReady ? await getHubTotals(env) : emptyHubSummary().totals,
    links,
    monitors,
    mail,
    dailyEvents: eventRows,
  };
}

function emptyHubSummary() {
  return {
    dbReady: false,
    queueReady: false,
    mailboxReady: false,
    analyticsReady: false,
    monitorEnvTargets: 0,
    totals: {
      links: 0,
      activeLinks: 0,
      clicks: 0,
      monitorTargets: 0,
      monitorFailures24h: 0,
      emails: 0,
      events14d: 0,
    },
    links: [],
    monitors: [],
    mail: [],
    dailyEvents: [],
  };
}

async function getHubTotals(env) {
  const [links, activeLinks, clicks, monitorTargets, monitorFailures, emails, events] = await Promise.all([
    scalar(env, 'SELECT COUNT(*) AS value FROM hub_short_links'),
    scalar(env, 'SELECT COUNT(*) AS value FROM hub_short_links WHERE enabled = 1'),
    scalar(env, 'SELECT COALESCE(SUM(clicks), 0) AS value FROM hub_short_links'),
    scalar(env, 'SELECT COUNT(*) AS value FROM hub_monitor_targets'),
    scalar(env, "SELECT COUNT(*) AS value FROM hub_monitor_checks WHERE ok = 0 AND checked_at >= datetime('now', '-1 day')"),
    scalar(env, 'SELECT COUNT(*) AS value FROM hub_inbound_emails'),
    scalar(env, "SELECT COALESCE(SUM(count), 0) AS value FROM hub_event_daily WHERE day >= date('now', '-14 day')"),
  ]);

  return {
    links,
    activeLinks,
    clicks,
    monitorTargets,
    monitorFailures24h: monitorFailures,
    emails,
    events14d: events,
  };
}

async function listShortLinks(env, limit = 100) {
  const result = await getHubDb(env)
    .prepare(`
      SELECT slug, target_url, title, description, enabled, clicks, expires_at, created_at, updated_at, last_clicked_at
      FROM hub_short_links
      ORDER BY updated_at DESC
      LIMIT ?
    `)
    .bind(limit)
    .all();
  return result.results || [];
}

async function getShortLink(env, slug) {
  if (!env.HUB_DB) return null;
  return getHubDb(env)
    .prepare(`
      SELECT slug, target_url, title, description, enabled, clicks, expires_at, created_at, updated_at, last_clicked_at
      FROM hub_short_links
      WHERE slug = ?
    `)
    .bind(slug)
    .first();
}

async function createShortLink(env, values) {
  const now = utcNow();
  const targetUrl = normalizeTargetUrl(values.target_url || values.targetUrl || values.url);
  const slug = normalizeSlug(values.slug) || await generateUniqueSlug(env, targetUrl);
  const title = cleanText(values.title, 120);
  const description = cleanText(values.description, 500);
  const expiresAt = normalizeOptionalDate(values.expires_at || values.expiresAt);

  if (!isValidSlug(slug)) {
    throw new HubInputError('短链 slug 只能使用 3-64 位小写字母、数字、下划线或短横线');
  }

  await getHubDb(env)
    .prepare(`
      INSERT INTO hub_short_links (slug, target_url, title, description, enabled, clicks, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        target_url = excluded.target_url,
        title = excluded.title,
        description = excluded.description,
        expires_at = excluded.expires_at,
        enabled = 1,
        updated_at = excluded.updated_at
    `)
    .bind(slug, targetUrl, title, description, expiresAt, now, now)
    .run();

  console.info('hub short link saved', { slug, targetHost: new URL(targetUrl).hostname, hasExpiry: Boolean(expiresAt) });
  return getShortLink(env, slug);
}

async function updateShortLinkState(env, slug, action) {
  if (!isValidSlug(slug)) throw new HubInputError('短链不存在');
  const now = utcNow();
  const enabled = action === 'disable' ? 0 : 1;

  if (action === 'delete') {
    await getHubDb(env).prepare('DELETE FROM hub_short_links WHERE slug = ?').bind(slug).run();
    console.info('hub short link deleted', { slug });
    return { slug, deleted: true };
  }

  await getHubDb(env)
    .prepare('UPDATE hub_short_links SET enabled = ?, updated_at = ? WHERE slug = ?')
    .bind(enabled, now, slug)
    .run();

  console.info('hub short link state updated', { slug, enabled: Boolean(enabled) });
  return getShortLink(env, slug);
}

async function markShortLinkClicked(env, slug, occurredAt) {
  if (!env.HUB_DB) return;
  await getHubDb(env)
    .prepare('UPDATE hub_short_links SET clicks = clicks + 1, last_clicked_at = ?, updated_at = ? WHERE slug = ?')
    .bind(occurredAt, occurredAt, slug)
    .run();
}

async function generateUniqueSlug(env, seed) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = shortHash(`${seed}:${Date.now()}:${Math.random()}`).padStart(8, '0').slice(0, 8 + attempt);
    const existing = await getShortLink(env, slug);
    if (!existing) return slug;
  }
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

async function listMonitorTargets(env, options = {}) {
  const {
    includeEnvTargets = false,
    enabledOnly = false,
  } = options;
  let targets = [];

  if (env.HUB_DB) {
    const where = enabledOnly ? 'WHERE enabled = 1' : '';
    const result = await getHubDb(env)
      .prepare(`
        SELECT id, label, url, method, expected_status_min, expected_status_max, timeout_ms, enabled,
               created_at, updated_at, last_checked_at, last_ok, last_status, last_latency_ms, last_error
        FROM hub_monitor_targets
        ${where}
        ORDER BY label ASC, created_at DESC
      `)
      .all();
    targets = result.results || [];
  }

  if (includeEnvTargets) {
    const existingIds = new Set(targets.map((target) => target.id));
    for (const target of parseEnvMonitorTargets(env)) {
      if (!enabledOnly || target.enabled) {
        if (!existingIds.has(target.id)) targets.push(target);
      }
    }
  }

  return targets;
}

async function createMonitorTarget(env, values) {
  const now = utcNow();
  const url = normalizeTargetUrl(values.url);
  const label = cleanText(values.label || new URL(url).hostname, 120);
  const id = normalizeMonitorId(values.id || label || url);
  const method = normalizeMonitorMethod(values.method);
  const expectedMin = parseInteger(values.expected_status_min || values.expectedStatusMin, 200);
  const expectedMax = parseInteger(values.expected_status_max || values.expectedStatusMax, 399);
  const timeoutMs = clamp(parseInteger(values.timeout_ms || values.timeoutMs, DEFAULT_MONITOR_TIMEOUT_MS), 1000, 30000);

  await getHubDb(env)
    .prepare(`
      INSERT INTO hub_monitor_targets (
        id, label, url, method, expected_status_min, expected_status_max, timeout_ms,
        enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        url = excluded.url,
        method = excluded.method,
        expected_status_min = excluded.expected_status_min,
        expected_status_max = excluded.expected_status_max,
        timeout_ms = excluded.timeout_ms,
        enabled = 1,
        updated_at = excluded.updated_at
    `)
    .bind(id, label, url, method, expectedMin, expectedMax, timeoutMs, now, now)
    .run();

  console.info('hub monitor target saved', { id, host: new URL(url).hostname, method });
  return getMonitorTarget(env, id);
}

async function updateMonitorTargetState(env, id, action) {
  const cleanId = normalizeMonitorId(id);
  if (!cleanId) throw new HubInputError('监控目标不存在');

  if (action === 'delete') {
    await getHubDb(env).prepare('DELETE FROM hub_monitor_targets WHERE id = ?').bind(cleanId).run();
    console.info('hub monitor target deleted', { id: cleanId });
    return { id: cleanId, deleted: true };
  }

  const now = utcNow();
  const enabled = action === 'disable' ? 0 : 1;
  await getHubDb(env)
    .prepare('UPDATE hub_monitor_targets SET enabled = ?, updated_at = ? WHERE id = ?')
    .bind(enabled, now, cleanId)
    .run();

  console.info('hub monitor target state updated', { id: cleanId, enabled: Boolean(enabled) });
  return getMonitorTarget(env, cleanId);
}

async function getMonitorTarget(env, id) {
  return getHubDb(env)
    .prepare(`
      SELECT id, label, url, method, expected_status_min, expected_status_max, timeout_ms, enabled,
             created_at, updated_at, last_checked_at, last_ok, last_status, last_latency_ms, last_error
      FROM hub_monitor_targets
      WHERE id = ?
    `)
    .bind(normalizeMonitorId(id))
    .first();
}

async function checkMonitorById(env, id) {
  const cleanId = normalizeMonitorId(id);
  const dbTarget = env.HUB_DB ? await getMonitorTarget(env, cleanId) : null;
  const envTarget = parseEnvMonitorTargets(env).find((target) => target.id === cleanId);
  const target = dbTarget || envTarget;
  if (!target) throw new HubInputError('监控目标不存在');
  return runMonitorCheck(env, target, { source: 'manual' });
}

async function runMonitorCheck(env, target, metadata = {}) {
  const checkedAt = utcNow();
  const started = Date.now();
  const controller = new AbortController();
  const timeoutMs = clamp(parseInteger(target.timeout_ms, DEFAULT_MONITOR_TIMEOUT_MS), 1000, 30000);
  const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
  let status = 0;
  let ok = false;
  let errorMessage = '';

  try {
    const response = await fetch(target.url, {
      method: normalizeMonitorMethod(target.method),
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent': '8xd-hub-monitor/1.0',
      },
    });
    status = response.status;
    ok = status >= Number(target.expected_status_min || 200) && status <= Number(target.expected_status_max || 399);
    if (!ok) errorMessage = `Unexpected status ${status}`;
  } catch (error) {
    errorMessage = error?.name === 'AbortError' ? `Timed out after ${timeoutMs}ms` : String(error?.message || error);
  } finally {
    clearTimeout(timeout);
  }

  const latencyMs = Date.now() - started;
  const result = {
    id: crypto.randomUUID(),
    targetId: target.id,
    label: target.label,
    url: target.url,
    checkedAt,
    ok,
    status,
    latencyMs,
    error: errorMessage,
    source: metadata.source || 'manual',
  };

  await recordMonitorResult(env, target, result);
  await recordHubEvent(env, {
    eventType: ok ? 'monitor_ok' : 'monitor_failed',
    resourceType: 'monitor',
    resourceId: target.id,
    occurredAt: checkedAt,
    country: '',
    referrerHost: '',
    userAgentFamily: metadata.source || 'monitor',
  });

  console.info('hub monitor checked', {
    targetId: target.id,
    ok,
    status,
    latencyMs,
    source: result.source,
  });
  return result;
}

async function recordMonitorResult(env, target, result) {
  if (!env.HUB_DB || target.source === 'env') return;
  const db = getHubDb(env);
  await db.batch([
    db.prepare(`
      INSERT INTO hub_monitor_checks (id, target_id, checked_at, ok, status, latency_ms, error, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(result.id, target.id, result.checkedAt, result.ok ? 1 : 0, result.status, result.latencyMs, result.error, result.source),
    db.prepare(`
      UPDATE hub_monitor_targets
      SET last_checked_at = ?, last_ok = ?, last_status = ?, last_latency_ms = ?, last_error = ?, updated_at = ?
      WHERE id = ?
    `).bind(result.checkedAt, result.ok ? 1 : 0, result.status, result.latencyMs, result.error, result.checkedAt, target.id),
  ]);
}

async function listInboundEmails(env, limit = 50) {
  const result = await getHubDb(env)
    .prepare(`
      SELECT id, received_at, mail_from, rcpt_to, subject, raw_key, raw_size, status, preview
      FROM hub_inbound_emails
      ORDER BY received_at DESC
      LIMIT ?
    `)
    .bind(limit)
    .all();
  return result.results || [];
}

async function storeInboundEmail(message, env) {
  const receivedAt = utcNow();
  const id = `${receivedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
  const subject = cleanText(message.headers?.get?.('subject') || '', 300);
  const headersJson = JSON.stringify(headersToObject(message.headers));
  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const rawSize = message.rawSize || rawBuffer.byteLength;
  const preview = buildEmailPreview(rawBuffer);
  let rawKey = '';

  if (env.HUB_MAILBOX) {
    rawKey = `emails/${id}.eml`;
    await env.HUB_MAILBOX.put(rawKey, rawBuffer, {
      httpMetadata: { contentType: 'message/rfc822' },
      customMetadata: {
        from: maskEmail(message.from),
        to: maskEmail(message.to),
        receivedAt,
      },
    });
  }

  if (env.HUB_DB) {
    await getHubDb(env)
      .prepare(`
        INSERT INTO hub_inbound_emails (
          id, received_at, mail_from, rcpt_to, subject, raw_key, raw_size, headers_json, status, preview
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        id,
        receivedAt,
        message.from || '',
        message.to || '',
        subject,
        rawKey,
        rawSize,
        headersJson,
        rawKey ? 'stored' : 'metadata-only',
        preview,
      )
      .run();
  }

  console.info('hub email stored', {
    id,
    from: maskEmail(message.from),
    to: maskEmail(message.to),
    rawSize,
    hasRawObject: Boolean(rawKey),
  });

  return { id, receivedAt, rawKey, rawSize };
}

async function listEventDaily(env, days = 14) {
  const result = await getHubDb(env)
    .prepare(`
      SELECT day, event_type, resource_type, resource_id, SUM(count) AS count
      FROM hub_event_daily
      WHERE day >= date('now', ?)
      GROUP BY day, event_type, resource_type, resource_id
      ORDER BY day DESC, count DESC
      LIMIT 100
    `)
    .bind(`-${days} day`)
    .all();
  return result.results || [];
}

async function recordHubEvent(env, event) {
  const normalized = normalizeQueuedEvent(event);

  try {
    if (env.HUB_ANALYTICS?.writeDataPoint) {
      env.HUB_ANALYTICS.writeDataPoint({
        indexes: [normalized.eventType],
        blobs: [
          normalized.resourceType,
          normalized.resourceId,
          normalized.country,
          normalized.referrerHost,
          normalized.userAgentFamily,
        ],
        doubles: [1],
      });
    }
  } catch (error) {
    console.warn('hub analytics write failed', { error });
  }

  if (env.HUB_EVENTS?.send) {
    await env.HUB_EVENTS.send(normalized);
    return;
  }

  await recordHubEventDirect(env, normalized);
}

async function recordHubEventDirect(env, event) {
  if (!env.HUB_DB) return;
  const normalized = normalizeQueuedEvent(event);
  const day = normalized.occurredAt.slice(0, 10);

  await getHubDb(env)
    .prepare(`
      INSERT INTO hub_event_daily (
        day, event_type, resource_type, resource_id, country, referrer_host, user_agent_family,
        count, first_seen_at, last_seen_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(day, event_type, resource_type, resource_id, country, referrer_host, user_agent_family)
      DO UPDATE SET
        count = count + 1,
        last_seen_at = excluded.last_seen_at
    `)
    .bind(
      day,
      normalized.eventType,
      normalized.resourceType,
      normalized.resourceId,
      normalized.country,
      normalized.referrerHost,
      normalized.userAgentFamily,
      normalized.occurredAt,
      normalized.occurredAt,
    )
    .run();
}

function buildRequestEvent(request, base) {
  return {
    ...base,
    occurredAt: utcNow(),
    country: cleanDimension(request.cf?.country || ''),
    referrerHost: referrerHost(request.headers.get('Referer') || ''),
    userAgentFamily: userAgentFamily(request.headers.get('User-Agent') || ''),
  };
}

function normalizeQueuedEvent(event) {
  const input = event && typeof event === 'object' ? event : {};
  return {
    eventType: cleanDimension(input.eventType || input.event_type || 'unknown'),
    resourceType: cleanDimension(input.resourceType || input.resource_type || 'unknown'),
    resourceId: cleanDimension(input.resourceId || input.resource_id || 'unknown'),
    occurredAt: normalizeOptionalDate(input.occurredAt || input.occurred_at) || utcNow(),
    country: cleanDimension(input.country || ''),
    referrerHost: cleanDimension(input.referrerHost || input.referrer_host || ''),
    userAgentFamily: cleanDimension(input.userAgentFamily || input.user_agent_family || ''),
  };
}

function parseEnvMonitorTargets(env) {
  const raw = String(env.HUB_MONITOR_TARGETS || '').trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => normalizeEnvMonitorTarget(item)).filter(Boolean);
    }
  } catch {
    // Fall through to comma-separated parsing.
  }

  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [labelPart, urlPart] = part.includes('=') ? part.split(/=(.*)/s) : ['', part];
      return normalizeEnvMonitorTarget({
        label: labelPart || urlPart,
        url: urlPart || labelPart,
      });
    })
    .filter(Boolean);
}

function normalizeEnvMonitorTarget(item) {
  try {
    const url = normalizeTargetUrl(item.url || item.href);
    const label = cleanText(item.label || new URL(url).hostname, 120);
    return {
      id: normalizeMonitorId(item.id || label || url),
      label,
      url,
      method: normalizeMonitorMethod(item.method),
      expected_status_min: parseInteger(item.expected_status_min || item.expectedStatusMin, 200),
      expected_status_max: parseInteger(item.expected_status_max || item.expectedStatusMax, 399),
      timeout_ms: clamp(parseInteger(item.timeout_ms || item.timeoutMs, DEFAULT_MONITOR_TIMEOUT_MS), 1000, 30000),
      enabled: item.enabled === undefined ? 1 : (item.enabled ? 1 : 0),
      source: 'env',
    };
  } catch {
    return null;
  }
}

function renderHubPage(summary, options = {}) {
  const {
    csrfToken = '',
    notice = '',
    error = '',
  } = options;
  const setupItems = [
    ['D1', summary.dbReady, 'HUB_DB'],
    ['Queue', summary.queueReady, 'HUB_EVENTS'],
    ['Mailbox R2', summary.mailboxReady, 'HUB_MAILBOX'],
    ['Analytics', summary.analyticsReady, 'HUB_ANALYTICS'],
  ];
  const toasts = [
    notice ? { type: 'success', message: notice } : null,
    error ? { type: 'error', message: error } : null,
    summary.dbReady ? null : { type: 'warning', message: 'HUB_DB 未绑定，Hub 管理能力处于只读配置态。' },
  ].filter(Boolean);

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="share-pages-admin-csrf" content="${escapeHtml(csrfToken)}" />
    <title>8XD Cloudflare Hub</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f7f9;
        --panel: #ffffff;
        --panel-alt: #f0f5f4;
        --text: #17202a;
        --muted: #657282;
        --line: #d8dee8;
        --accent: #0f766e;
        --accent-ink: #064e49;
        --danger: #b42318;
        --success: #117a4b;
        --warning: #a15c00;
        --control: #fbfcfe;
      }
      @media (prefers-color-scheme: dark) {
        :root {
          color-scheme: dark;
          --bg: #101820;
          --panel: #172331;
          --panel-alt: #102923;
          --text: #edf2f7;
          --muted: #aeb8c5;
          --line: #2c3a4a;
          --accent: #2dd4bf;
          --accent-ink: #b7fff4;
          --danger: #ff7b72;
          --success: #70e0a3;
          --warning: #ffd166;
          --control: #111b28;
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
        width: min(1180px, calc(100vw - 36px));
        margin: 34px auto 64px;
      }
      header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 18px;
        margin-bottom: 22px;
      }
      h1, h2, h3, p { margin: 0; letter-spacing: 0; }
      h1 { font-size: 28px; }
      h2 { font-size: 18px; }
      h3 { font-size: 15px; }
      p, .muted { color: var(--muted); line-height: 1.65; }
      a { color: inherit; }
      .nav {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .button, button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-height: 34px;
        padding: 0 12px;
        border: 1px solid var(--line);
        border-radius: 7px;
        background: var(--panel);
        color: var(--text);
        font: inherit;
        font-size: 13px;
        text-decoration: none;
        cursor: pointer;
      }
      button.primary {
        border-color: var(--accent);
        background: var(--accent);
        color: #ffffff;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
        margin-bottom: 18px;
      }
      .card, .panel {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        box-shadow: 0 12px 28px rgba(15, 23, 32, 0.06);
      }
      .card {
        padding: 14px;
      }
      .metric {
        margin-top: 8px;
        font-size: 28px;
        font-weight: 800;
      }
      .metric-sub {
        margin-top: 2px;
        color: var(--muted);
        font-size: 12px;
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr);
        gap: 14px;
        align-items: start;
      }
      .panel {
        margin-bottom: 14px;
        overflow: hidden;
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px;
        border-bottom: 1px solid var(--line);
        background: var(--panel-alt);
      }
      .panel-body {
        padding: 14px 16px 16px;
      }
      form {
        display: grid;
        gap: 10px;
      }
      .form-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(140px, 0.3fr);
        gap: 10px;
      }
      label {
        display: grid;
        gap: 5px;
        color: var(--muted);
        font-size: 12px;
        font-weight: 700;
      }
      input, select {
        min-width: 0;
        width: 100%;
        min-height: 36px;
        border: 1px solid var(--line);
        border-radius: 7px;
        background: var(--control);
        color: var(--text);
        padding: 7px 9px;
        font: inherit;
        font-size: 14px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        padding: 10px 8px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
        font-size: 13px;
      }
      th {
        color: var(--muted);
        font-size: 12px;
        font-weight: 800;
      }
      tr:last-child td { border-bottom: 0; }
      .status {
        display: inline-flex;
        align-items: center;
        min-height: 24px;
        padding: 0 8px;
        border-radius: 999px;
        background: rgba(17, 122, 75, 0.12);
        color: var(--success);
        font-size: 12px;
        font-weight: 800;
      }
      .status.off, .status.fail {
        background: rgba(180, 35, 24, 0.12);
        color: var(--danger);
      }
      .status.warn {
        background: rgba(161, 92, 0, 0.12);
        color: var(--warning);
      }
      .actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .toast-viewport {
        position: fixed;
        top: 18px;
        right: 18px;
        z-index: 20;
        display: grid;
        gap: 8px;
        width: min(360px, calc(100vw - 36px));
      }
      .toast {
        padding: 11px 13px;
        border: 1px solid var(--line);
        border-left: 4px solid var(--success);
        border-radius: 8px;
        background: var(--panel);
        color: var(--text);
        box-shadow: 0 12px 32px rgba(15, 23, 32, 0.14);
        font-size: 13px;
      }
      .toast.error { border-left-color: var(--danger); }
      .toast.warning { border-left-color: var(--warning); }
      .empty {
        padding: 16px;
        border: 1px dashed var(--line);
        border-radius: 8px;
        color: var(--muted);
        text-align: center;
      }
      code {
        padding: 2px 5px;
        border-radius: 5px;
        background: var(--panel-alt);
        color: var(--accent-ink);
      }
      @media (max-width: 860px) {
        header, .layout { grid-template-columns: 1fr; display: grid; }
        .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .form-grid { grid-template-columns: 1fr; }
      }
      @media (max-width: 560px) {
        main { width: min(100vw - 24px, 1180px); margin-top: 22px; }
        .grid { grid-template-columns: 1fr; }
        th:nth-child(3), td:nth-child(3) { display: none; }
      }
    </style>
  </head>
  <body>
    <div class="toast-viewport">${toasts.map(renderToast).join('')}</div>
    <main>
      <header>
        <div>
          <h1>8XD Cloudflare Hub</h1>
          <p>Links, uptime, mailbox, and edge analytics for 8xd.io.</p>
        </div>
        <nav class="nav">
          <a class="button" href="/">Share Pages</a>
          <a class="button" href="/logout">Logout</a>
        </nav>
      </header>

      <section class="grid">
        ${renderMetricCard('短链', summary.totals.links, `${summary.totals.clicks} redirects`)}
        ${renderMetricCard('监控', summary.totals.monitorTargets, `${summary.totals.monitorFailures24h} failures / 24h`)}
        ${renderMetricCard('邮件', summary.totals.emails, summary.mailboxReady ? 'raw archive enabled' : 'metadata only')}
        ${renderMetricCard('事件', summary.totals.events14d, 'last 14 days')}
      </section>

      <section class="layout">
        <div>
          ${renderShortLinksPanel(summary.links, csrfToken)}
          ${renderMonitorPanel(summary.monitors, csrfToken)}
        </div>
        <aside>
          ${renderSetupPanel(setupItems)}
          ${renderMailboxPanel(summary.mail)}
          ${renderEventsPanel(summary.dailyEvents)}
        </aside>
      </section>
    </main>
    <script>
      const csrfToken = document.querySelector('meta[name="share-pages-admin-csrf"]')?.content || '';
      const showToast = (message, type = 'success') => {
        const viewport = document.querySelector('.toast-viewport');
        const toast = document.createElement('div');
        toast.className = 'toast ' + type;
        toast.textContent = message;
        viewport.appendChild(toast);
        window.setTimeout(() => toast.remove(), 3600);
      };
      const submitJson = async (form) => {
        const response = await fetch(form.action, {
          method: 'POST',
          headers: { 'X-CSRF-Token': csrfToken },
          body: new FormData(form),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok) throw new Error(result.error || 'Request failed');
        return result;
      };
      document.querySelectorAll('[data-async-form]').forEach((form) => {
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const button = form.querySelector('button[type="submit"]');
          if (button) button.disabled = true;
          try {
            await submitJson(form);
            showToast(form.dataset.success || 'Saved');
            window.setTimeout(() => window.location.reload(), 450);
          } catch (error) {
            showToast(error.message || 'Request failed', 'error');
            if (button) button.disabled = false;
          }
        });
      });
    </script>
  </body>
</html>`;
}

function renderMetricCard(label, value, subtext) {
  return `<article class="card">
    <p>${escapeHtml(label)}</p>
    <div class="metric">${escapeHtml(String(value ?? 0))}</div>
    <div class="metric-sub">${escapeHtml(subtext || '')}</div>
  </article>`;
}

function renderShortLinksPanel(links, csrfToken) {
  return `<section class="panel">
    <div class="panel-head">
      <h2>短链</h2>
      <span class="muted">${links.length} shown</span>
    </div>
    <div class="panel-body">
      <form action="${HUB_API_PREFIX}/links" method="post" data-async-form data-success="短链已保存">
        <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}" />
        <div class="form-grid">
          <label>目标 URL
            <input required name="target_url" type="url" placeholder="https://example.com/path" />
          </label>
          <label>Slug
            <input name="slug" inputmode="latin" placeholder="auto" />
          </label>
        </div>
        <div class="form-grid">
          <label>标题
            <input name="title" placeholder="可选" />
          </label>
          <label>过期时间
            <input name="expires_at" type="datetime-local" />
          </label>
        </div>
        <button class="primary" type="submit">保存短链</button>
      </form>
      ${links.length ? `<table>
        <thead><tr><th>Slug</th><th>目标</th><th>点击</th><th>状态</th><th></th></tr></thead>
        <tbody>${links.map((link) => renderShortLinkRow(link, csrfToken)).join('')}</tbody>
      </table>` : '<div class="empty">No short links yet.</div>'}
    </div>
  </section>`;
}

function renderShortLinkRow(link, csrfToken) {
  const enabled = Boolean(link.enabled);
  const publicPath = `/s/${link.slug}`;
  return `<tr>
    <td><a href="${escapeHtml(publicPath)}" target="_blank" rel="noreferrer">${escapeHtml(link.slug)}</a></td>
    <td>
      <strong>${escapeHtml(link.title || link.target_url)}</strong>
      <div class="muted">${escapeHtml(link.target_url)}</div>
    </td>
    <td>${escapeHtml(String(link.clicks || 0))}</td>
    <td><span class="status ${enabled ? '' : 'off'}">${enabled ? 'active' : 'off'}</span></td>
    <td>
      <form class="actions" action="${HUB_API_PREFIX}/links/${escapeHtml(link.slug)}" method="post" data-async-form data-success="短链已更新">
        <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}" />
        <button name="action" value="${enabled ? 'disable' : 'enable'}" type="submit">${enabled ? '停用' : '启用'}</button>
        <button name="action" value="delete" type="submit">删除</button>
      </form>
    </td>
  </tr>`;
}

function renderMonitorPanel(monitors, csrfToken) {
  return `<section class="panel">
    <div class="panel-head">
      <h2>站点监控</h2>
      <span class="muted">${monitors.length} targets</span>
    </div>
    <div class="panel-body">
      <form action="${HUB_API_PREFIX}/monitors" method="post" data-async-form data-success="监控目标已保存">
        <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}" />
        <div class="form-grid">
          <label>URL
            <input required name="url" type="url" placeholder="https://8xd.io/" />
          </label>
          <label>名称
            <input name="label" placeholder="8xd.io" />
          </label>
        </div>
        <div class="form-grid">
          <label>方法
            <select name="method"><option>GET</option><option>HEAD</option></select>
          </label>
          <label>超时 ms
            <input name="timeout_ms" type="number" min="1000" max="30000" value="${DEFAULT_MONITOR_TIMEOUT_MS}" />
          </label>
        </div>
        <button class="primary" type="submit">保存监控</button>
      </form>
      ${monitors.length ? `<table>
        <thead><tr><th>目标</th><th>最近结果</th><th>延迟</th><th>状态</th><th></th></tr></thead>
        <tbody>${monitors.map((target) => renderMonitorRow(target, csrfToken)).join('')}</tbody>
      </table>` : '<div class="empty">No monitor targets yet.</div>'}
    </div>
  </section>`;
}

function renderMonitorRow(target, csrfToken) {
  const enabled = Boolean(target.enabled);
  const okKnown = target.last_ok !== null && target.last_ok !== undefined;
  const ok = Number(target.last_ok) === 1;
  const statusClass = !enabled ? 'off' : (!okKnown ? 'warn' : (ok ? '' : 'fail'));
  const statusText = !enabled ? 'off' : (!okKnown ? 'pending' : (ok ? 'ok' : 'fail'));
  const source = target.source === 'env' ? 'env' : 'db';
  return `<tr>
    <td>
      <strong>${escapeHtml(target.label || target.id)}</strong>
      <div class="muted">${escapeHtml(target.url)} · ${escapeHtml(source)}</div>
    </td>
    <td>${target.last_status ? escapeHtml(String(target.last_status)) : '-'}<div class="muted">${escapeHtml(formatShortDate(target.last_checked_at))}</div></td>
    <td>${target.last_latency_ms ? `${escapeHtml(String(target.last_latency_ms))}ms` : '-'}</td>
    <td><span class="status ${statusClass}">${statusText}</span></td>
    <td>
      <form class="actions" action="${HUB_API_PREFIX}/monitors/${escapeHtml(target.id)}/check" method="post" data-async-form data-success="检测完成">
        <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}" />
        <button type="submit">检测</button>
      </form>
      ${target.source === 'env' ? '' : `<form class="actions" action="${HUB_API_PREFIX}/monitors/${escapeHtml(target.id)}" method="post" data-async-form data-success="监控已更新">
        <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}" />
        <button name="action" value="${enabled ? 'disable' : 'enable'}" type="submit">${enabled ? '停用' : '启用'}</button>
        <button name="action" value="delete" type="submit">删除</button>
      </form>`}
    </td>
  </tr>`;
}

function renderSetupPanel(items) {
  return `<section class="panel">
    <div class="panel-head"><h2>绑定状态</h2></div>
    <div class="panel-body">
      <table><tbody>${items.map(([label, ok, binding]) => `<tr>
        <td>${escapeHtml(label)}</td>
        <td><code>${escapeHtml(binding)}</code></td>
        <td><span class="status ${ok ? '' : 'warn'}">${ok ? 'ready' : 'missing'}</span></td>
      </tr>`).join('')}</tbody></table>
    </div>
  </section>`;
}

function renderMailboxPanel(mail) {
  return `<section class="panel">
    <div class="panel-head"><h2>邮箱</h2><span class="muted">${mail.length} recent</span></div>
    <div class="panel-body">
      ${mail.length ? `<table><tbody>${mail.map((item) => `<tr>
        <td>
          <strong>${escapeHtml(item.subject || '(no subject)')}</strong>
          <div class="muted">${escapeHtml(maskEmail(item.mail_from))} -> ${escapeHtml(maskEmail(item.rcpt_to))}</div>
        </td>
        <td>${escapeHtml(formatShortDate(item.received_at))}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">No routed email yet.</div>'}
    </div>
  </section>`;
}

function renderEventsPanel(events) {
  return `<section class="panel">
    <div class="panel-head"><h2>事件</h2><span class="muted">${events.length} rows</span></div>
    <div class="panel-body">
      ${events.length ? `<table><tbody>${events.slice(0, 12).map((event) => `<tr>
        <td><strong>${escapeHtml(event.event_type)}</strong><div class="muted">${escapeHtml(event.resource_type)}:${escapeHtml(event.resource_id)}</div></td>
        <td>${escapeHtml(event.day)}</td>
        <td>${escapeHtml(String(event.count || 0))}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty">No event aggregates yet.</div>'}
    </div>
  </section>`;
}

function renderToast(toast) {
  return `<div class="toast ${escapeHtml(toast.type)}">${escapeHtml(toast.message)}</div>`;
}

function renderHubError(message) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>8XD Link</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Inter,system-ui,sans-serif;background:#f6f7f9;color:#17202a}.box{width:min(420px,calc(100vw - 32px));padding:26px;border:1px solid #d8dee8;border-radius:8px;background:#fff;text-align:center}h1{margin:0 0 10px;font-size:20px}p{margin:0;color:#657282;line-height:1.6}</style></head><body><main class="box"><h1>Link unavailable</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

function getHubDb(env) {
  if (!env.HUB_DB) throw new HubSetupError('HUB_DB 未绑定，请先创建 D1 数据库并应用 migrations。', 503);
  return env.HUB_DB;
}

async function scalar(env, sql) {
  const row = await getHubDb(env).prepare(sql).first();
  return Number(row?.value || 0);
}

async function readRequestData(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) {
    const values = await request.json();
    return { values: values && typeof values === 'object' ? values : {}, formData: new FormData() };
  }

  const formData = await request.formData();
  return { values: Object.fromEntries(formData.entries()), formData };
}

async function verifyHubMutation(ui, formData) {
  if (!ui.verifyAdminCsrfToken) return { ok: false, error: 'CSRF context missing' };
  return ui.verifyAdminCsrfToken(formData || new FormData());
}

function wantsJson(request) {
  const accept = request.headers.get('Accept') || '';
  const requestedWith = request.headers.get('X-Requested-With') || '';
  return accept.includes('application/json') || requestedWith === 'fetch';
}

function normalizeTargetUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new HubInputError('URL 不能为空');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HubInputError('URL 格式无效');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new HubInputError('URL 只支持 http 或 https');
  }
  return url.toString();
}

function normalizeSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function isValidSlug(slug) {
  return /^[a-z0-9][a-z0-9_-]{2,63}$/.test(slug);
}

function normalizeMonitorId(value) {
  return normalizeSlug(value).slice(0, 80);
}

function normalizeMonitorMethod(value) {
  const method = String(value || 'GET').toUpperCase();
  return method === 'HEAD' ? 'HEAD' : 'GET';
}

function normalizeOptionalDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new HubInputError('时间格式无效');
  return date.toISOString();
}

function isExpired(value) {
  const expiresAt = String(value || '');
  return Boolean(expiresAt && expiresAt <= utcNow());
}

function cleanText(value, maxLength = 200) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function cleanDimension(value) {
  return cleanText(value, 120).toLowerCase();
}

function referrerHost(value) {
  if (!value) return '';
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function userAgentFamily(value) {
  const ua = String(value || '').toLowerCase();
  if (!ua) return '';
  if (ua.includes('bot') || ua.includes('crawler') || ua.includes('spider')) return 'bot';
  if (ua.includes('mobile') || ua.includes('iphone') || ua.includes('android')) return 'mobile';
  if (ua.includes('curl') || ua.includes('wget') || ua.includes('httpie')) return 'cli';
  return 'desktop';
}

function headersToObject(headers) {
  const output = {};
  if (!headers?.forEach) return output;
  headers.forEach((value, key) => {
    output[key.toLowerCase()] = String(value).slice(0, 1000);
  });
  return output;
}

function buildEmailPreview(rawBuffer) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(rawBuffer.slice(0, 8192));
  const body = text.split(/\r?\n\r?\n/).slice(1).join('\n\n') || text;
  return body.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function maskEmail(value) {
  const email = String(value || '');
  const at = email.indexOf('@');
  if (at <= 1) return email;
  return `${email.slice(0, 2)}***${email.slice(at)}`;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function shortHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function utcNow() {
  return new Date().toISOString();
}

function formatShortDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function humanHubError(error) {
  if (error instanceof HubInputError || error instanceof HubSetupError) return error.message;
  const message = error instanceof Error ? error.message : String(error || '');
  if (message.includes('no such table')) return 'HUB_DB schema 未初始化，请先应用 D1 migrations。';
  if (message.includes('HUB_DB')) return 'HUB_DB 未绑定，请先创建 D1 数据库。';
  return 'Hub 操作失败，请稍后重试';
}

class HubInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HubInputError';
    this.status = 400;
  }
}

class HubSetupError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.name = 'HubSetupError';
    this.status = status;
  }
}
