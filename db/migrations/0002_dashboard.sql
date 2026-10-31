-- 0002: dashboard logins. Additive only.

-- Last TOTP time-step used per user, so a code can't be replayed.
ALTER TABLE users ADD COLUMN mfa_last_step INTEGER;

-- Login sessions for the dashboard. Only a hash of the token is stored.
CREATE TABLE sessions (
	token_hash TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id),
	merchant_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL,
	ip TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

-- One-time setup links for new users (set a password, enrol an authenticator app).
CREATE TABLE user_invites (
	token_hash TEXT PRIMARY KEY,
	merchant_id TEXT NOT NULL,
	user_id TEXT NOT NULL REFERENCES users(id),
	mfa_secret_enc TEXT NOT NULL,             -- TOTP secret offered on the setup page, AES-GCM encrypted
	expires_at INTEGER NOT NULL,
	used_at INTEGER
);

-- Failed-login counters (per email and per IP), for throttling.
CREATE TABLE login_throttle (
	key TEXT PRIMARY KEY,
	failures INTEGER NOT NULL,
	window_start INTEGER NOT NULL
);
