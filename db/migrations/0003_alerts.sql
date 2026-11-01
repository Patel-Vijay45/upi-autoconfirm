-- 0003: walk-in hint on signals; phone-offline alerts. Additive only.

-- Unmatched payment not near any recent order (likely a walk-in customer). Display hint only.
ALTER TABLE signals ADD COLUMN walk_in INTEGER NOT NULL DEFAULT 0;

-- Browsers (dashboard users' phones) that asked for push alerts: phone offline/back, payments that need a look.
CREATE TABLE push_subscriptions (
	id TEXT PRIMARY KEY,                       -- psub_xxx
	merchant_id TEXT NOT NULL,
	user_id TEXT NOT NULL REFERENCES users(id),
	endpoint TEXT NOT NULL UNIQUE,             -- push service URL (allow-listed hosts only)
	p256dh TEXT NOT NULL,                      -- browser's public key (base64url)
	auth TEXT NOT NULL,                        -- browser's auth secret (base64url)
	label TEXT,                                -- e.g. "Chrome on Android"
	created_at INTEGER NOT NULL,
	last_sent_at INTEGER
);
CREATE INDEX push_subscriptions_merchant ON push_subscriptions(merchant_id);
