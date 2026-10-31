-- UPI AutoConfirm: system-of-record schema (Cloudflare D1 / SQLite).
-- This file is the full current schema. Applied changes live in db/migrations (additive only):
-- 0001_initial.sql is this file as first released.
-- Money: integer paise. Times: unix milliseconds. Every tenant-owned row has merchant_id.
-- The live matching state (active intents, reserved amounts, recent fingerprints) also lives inside
-- each location's Durable Object; D1 is the durable record and the source for dashboards/reports.

PRAGMA foreign_keys = ON;

-- ---------- Tenants ----------
CREATE TABLE merchants (
	id TEXT PRIMARY KEY,                       -- mer_xxx
	name TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
	plan TEXT NOT NULL DEFAULT 'free',
	settings TEXT NOT NULL DEFAULT '{}',      -- JSON: offset_mode, max_offset, intent_ttl, grace_window, reuse_cooldown,
	                                           --       auto_confirm_max (paise; null = no limit), limits (see MATCHING.md §1.1)
	created_at INTEGER NOT NULL
);

CREATE TABLE locations (                     -- a shop/branch/counter with its own UPI ID and phone(s)
	id TEXT PRIMARY KEY,                       -- loc_xxx
	merchant_id TEXT NOT NULL REFERENCES merchants(id),
	name TEXT NOT NULL,
	upi_vpa TEXT NOT NULL,                     -- merchant's own business UPI ID
	upi_payee_name TEXT NOT NULL,
	active INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL
);
CREATE INDEX locations_merchant ON locations(merchant_id);

CREATE TABLE users (                         -- dashboard logins
	id TEXT PRIMARY KEY,
	merchant_id TEXT NOT NULL REFERENCES merchants(id),
	email TEXT NOT NULL UNIQUE COLLATE NOCASE,
	password_hash TEXT,                        -- or passwordless / OAuth
	role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'staff', 'developer')),
	mfa_secret TEXT,                           -- TOTP, required for owner/admin
	active INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL,
	last_login INTEGER
);

CREATE TABLE api_keys (
	id TEXT PRIMARY KEY,
	merchant_id TEXT NOT NULL REFERENCES merchants(id),
	kind TEXT NOT NULL CHECK (kind IN ('secret', 'publishable')),
	livemode INTEGER NOT NULL,
	prefix TEXT NOT NULL,                      -- first 12 chars for display, e.g. sk_live_ab12
	key_hash TEXT NOT NULL UNIQUE,             -- sha256(full key); full key shown once
	created_at INTEGER NOT NULL,
	expires_at INTEGER,                        -- set on rotation (old key valid 24 h)
	last_used_at INTEGER,
	revoked_at INTEGER
);
CREATE INDEX api_keys_merchant ON api_keys(merchant_id);

-- ---------- Devices (merchant phones running the AutoConfirm app) ----------
CREATE TABLE devices (
	id TEXT PRIMARY KEY,                       -- dev_xxx
	merchant_id TEXT NOT NULL REFERENCES merchants(id),
	location_id TEXT NOT NULL REFERENCES locations(id),
	livemode INTEGER NOT NULL,                 -- test devices (e.g. the simulator) only feed test intents
	label TEXT NOT NULL,                       -- "Counter 1 phone"
	secret_hash TEXT NOT NULL,                 -- server keeps sha256(secret) + encrypted secret for HMAC (see SECURITY.md)
	secret_enc TEXT NOT NULL,                  -- AES-GCM(secret) with a key from Workers Secrets
	model TEXT, android_version TEXT, app_version TEXT,
	listener_enabled INTEGER NOT NULL DEFAULT 0,
	battery_optimized INTEGER,                 -- 1 = OS may kill app (warn merchant)
	last_heartbeat_at INTEGER,
	clock_offset_ms INTEGER NOT NULL DEFAULT 0, -- server time − phone time, measured on each heartbeat (MATCHING §3)
	last_signal_at INTEGER,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'online', 'offline', 'revoked')),
	created_at INTEGER NOT NULL
);
CREATE INDEX devices_location ON devices(location_id);
CREATE INDEX devices_heartbeat ON devices(status, last_heartbeat_at);

CREATE TABLE pairing_codes (                 -- short-lived code shown as QR in dashboard, scanned by the app
	code_hash TEXT PRIMARY KEY,
	merchant_id TEXT NOT NULL,
	location_id TEXT NOT NULL,
	livemode INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	used_at INTEGER
);

-- ---------- Payments ----------
CREATE TABLE payment_intents (
	id TEXT PRIMARY KEY,                       -- pi_xxx (unguessable, ≥ 80 bits)
	merchant_id TEXT NOT NULL REFERENCES merchants(id),
	location_id TEXT NOT NULL REFERENCES locations(id),
	livemode INTEGER NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'expired', 'cancelled')),
	amount INTEGER NOT NULL CHECK (amount > 0),
	unique_amount INTEGER NOT NULL CHECK (unique_amount >= amount),
	order_id TEXT,
	description TEXT,
	customer_name TEXT,
	customer_phone TEXT,
	return_url TEXT,
	metadata TEXT NOT NULL DEFAULT '{}',
	idempotency_key TEXT,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	customer_claimed_at INTEGER,
	paid_at INTEGER,
	paid_source TEXT CHECK (paid_source IS NULL OR paid_source IN ('auto', 'manual')),
	paid_by_user TEXT,                         -- for manual
	matched_signal_id TEXT,
	late INTEGER NOT NULL DEFAULT 0,
	amount_mismatch INTEGER NOT NULL DEFAULT 0,
	cancelled_at INTEGER,
	reserved_until INTEGER,                    -- unique_amount stays reserved until this time (set when the intent closes;
	                                           -- NULL while pending). Lets the DO rebuild its reserved set after a restart.
	updated_at INTEGER NOT NULL,
	UNIQUE (merchant_id, idempotency_key)
);
CREATE INDEX pi_merchant_created ON payment_intents(merchant_id, created_at);
CREATE INDEX pi_location_status ON payment_intents(location_id, status, expires_at);
CREATE INDEX pi_order ON payment_intents(merchant_id, order_id);
CREATE INDEX pi_reserved ON payment_intents(location_id, reserved_until);
-- Backstop for the invariant "open intents at a location never share an amount".
-- (The DO also enforces the reuse cool-down, which this index can't express.)
CREATE UNIQUE INDEX pi_open_amount ON payment_intents(location_id, unique_amount) WHERE status = 'pending';
-- A signal pays at most one intent.
CREATE UNIQUE INDEX pi_matched_signal ON payment_intents(matched_signal_id) WHERE matched_signal_id IS NOT NULL;

-- What the phone saw. Raw notification text is NOT stored here (see parse_failures, opt-in, short retention).
CREATE TABLE signals (
	id TEXT PRIMARY KEY,                       -- sig_xxx
	merchant_id TEXT NOT NULL,
	location_id TEXT NOT NULL,
	device_id TEXT NOT NULL,
	livemode INTEGER NOT NULL,
	app TEXT NOT NULL,                         -- phonepe_business | paytm_business | gpay_business | bharatpe | bank_sms | …
	amount INTEGER NOT NULL,
	payer_name TEXT,                           -- truncated to first name + initial (data minimisation)
	reference TEXT,                            -- UTR / UPI ref if present
	posted_at INTEGER NOT NULL,                -- phone time
	paid_time INTEGER NOT NULL,                -- posted_at + device clock_offset, capped at received_at (MATCHING §3)
	received_at INTEGER NOT NULL,              -- server time (used for grace windows)
	fingerprint TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('matched', 'unmatched', 'ambiguous', 'review', 'ignored', 'duplicate')),
	payment_intent_id TEXT,                    -- matched intent, or the suggested intent while status = 'review'
	duplicate_of TEXT,                         -- first signal of the same payment, when status = 'duplicate'
	note TEXT,
	UNIQUE (location_id, fingerprint)
);
CREATE INDEX signals_inbox ON signals(merchant_id, status, received_at);
CREATE INDEX signals_dedupe ON signals(location_id, amount, paid_time);

CREATE TABLE parse_failures (                -- only if merchant opted in; auto-deleted after 7 days
	id INTEGER PRIMARY KEY,
	merchant_id TEXT NOT NULL,
	location_id TEXT NOT NULL,
	device_id TEXT NOT NULL,
	app TEXT NOT NULL,
	redacted_text TEXT NOT NULL,               -- digits except the amount masked on device
	rules_version TEXT NOT NULL,
	received_at INTEGER NOT NULL
);
CREATE INDEX parse_failures_merchant ON parse_failures(merchant_id, received_at);

-- Parser rules (also cached in KV; devices pull by version)
CREATE TABLE parser_rules (
	version TEXT PRIMARY KEY,                  -- e.g. 2026-11-06.1
	rules TEXT NOT NULL,                       -- JSON (see ANDROID-APP.md §4)
	created_at INTEGER NOT NULL,
	active INTEGER NOT NULL DEFAULT 0
);

-- ---------- Webhooks ----------
CREATE TABLE webhook_endpoints (
	id TEXT PRIMARY KEY,
	merchant_id TEXT NOT NULL REFERENCES merchants(id),
	livemode INTEGER NOT NULL,                 -- receives only events of this mode
	url TEXT NOT NULL,
	events TEXT NOT NULL,                      -- JSON array
	secret_enc TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL
);

CREATE TABLE events (
	id TEXT PRIMARY KEY,                       -- evt_xxx
	merchant_id TEXT NOT NULL,
	livemode INTEGER NOT NULL,
	type TEXT NOT NULL,
	object_id TEXT NOT NULL,
	payload TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX events_merchant ON events(merchant_id, created_at);

CREATE TABLE webhook_deliveries (
	id INTEGER PRIMARY KEY,
	merchant_id TEXT NOT NULL,
	event_id TEXT NOT NULL,
	endpoint_id TEXT NOT NULL,
	attempt INTEGER NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
	http_status INTEGER,
	error TEXT,
	next_attempt_at INTEGER,
	created_at INTEGER NOT NULL
);
CREATE INDEX deliveries_pending ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX deliveries_merchant ON webhook_deliveries(merchant_id, event_id);

-- ---------- Audit (append-only) ----------
CREATE TABLE audit_log (
	id INTEGER PRIMARY KEY,
	merchant_id TEXT NOT NULL,
	actor TEXT NOT NULL,                       -- user:usr_x | key:sk_live_ab12 | device:dev_x | system
	action TEXT NOT NULL,                      -- intent.mark_paid, intent.unmark_paid, signal.assign, key.rotate, device.revoke…
	object_id TEXT,
	detail TEXT,                               -- JSON
	ip TEXT,
	at INTEGER NOT NULL
);
CREATE INDEX audit_merchant ON audit_log(merchant_id, at);

-- ---------- API idempotency (Idempotency-Key on POST). Device nonces live in each location's Durable Object storage. ----------
CREATE TABLE idempotency (
	merchant_id TEXT NOT NULL,
	key TEXT NOT NULL,
	request_hash TEXT NOT NULL,
	response TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (merchant_id, key)
);
