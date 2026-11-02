-- 0004: projects inside a merchant (one UPI ID, several websites/apps). Additive only.
-- A project has its own API keys and webhook endpoints; its keys only see its own payments.
-- project_id NULL = merchant-wide (old rows, merchant-wide keys and endpoints).

CREATE TABLE projects (
	id TEXT PRIMARY KEY,                       -- prj_xxx
	merchant_id TEXT NOT NULL REFERENCES merchants(id),
	name TEXT NOT NULL,
	active INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL
);
CREATE INDEX projects_merchant ON projects(merchant_id);

ALTER TABLE api_keys ADD COLUMN project_id TEXT;
ALTER TABLE payment_intents ADD COLUMN project_id TEXT;
ALTER TABLE webhook_endpoints ADD COLUMN project_id TEXT;
ALTER TABLE events ADD COLUMN project_id TEXT;
CREATE INDEX payment_intents_project ON payment_intents(merchant_id, project_id, created_at);

-- Finding a UPI ID across merchants (one UPI ID may belong to only one merchant).
CREATE INDEX locations_vpa ON locations(upi_vpa COLLATE NOCASE);
