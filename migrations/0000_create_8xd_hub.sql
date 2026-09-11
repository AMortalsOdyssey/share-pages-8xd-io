CREATE TABLE IF NOT EXISTS hub_short_links (
  slug TEXT PRIMARY KEY,
  target_url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  clicks INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_clicked_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_hub_short_links_updated_at
  ON hub_short_links (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_hub_short_links_enabled
  ON hub_short_links (enabled, expires_at);

CREATE TABLE IF NOT EXISTS hub_event_daily (
  day TEXT NOT NULL,
  event_type TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  referrer_host TEXT NOT NULL DEFAULT '',
  user_agent_family TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (
    day,
    event_type,
    resource_type,
    resource_id,
    country,
    referrer_host,
    user_agent_family
  )
);

CREATE INDEX IF NOT EXISTS idx_hub_event_daily_day
  ON hub_event_daily (day DESC, event_type);

CREATE TABLE IF NOT EXISTS hub_monitor_targets (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET',
  expected_status_min INTEGER NOT NULL DEFAULT 200,
  expected_status_max INTEGER NOT NULL DEFAULT 399,
  timeout_ms INTEGER NOT NULL DEFAULT 8000,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_checked_at TEXT NOT NULL DEFAULT '',
  last_ok INTEGER,
  last_status INTEGER,
  last_latency_ms INTEGER,
  last_error TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_hub_monitor_targets_enabled
  ON hub_monitor_targets (enabled, label);

CREATE TABLE IF NOT EXISTS hub_monitor_checks (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  status INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  FOREIGN KEY (target_id) REFERENCES hub_monitor_targets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_hub_monitor_checks_target_time
  ON hub_monitor_checks (target_id, checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_hub_monitor_checks_recent_failures
  ON hub_monitor_checks (ok, checked_at DESC);

CREATE TABLE IF NOT EXISTS hub_inbound_emails (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  mail_from TEXT NOT NULL,
  rcpt_to TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  raw_key TEXT NOT NULL DEFAULT '',
  raw_size INTEGER NOT NULL DEFAULT 0,
  headers_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'stored',
  preview TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_hub_inbound_emails_received_at
  ON hub_inbound_emails (received_at DESC);

CREATE INDEX IF NOT EXISTS idx_hub_inbound_emails_rcpt_to
  ON hub_inbound_emails (rcpt_to, received_at DESC);
