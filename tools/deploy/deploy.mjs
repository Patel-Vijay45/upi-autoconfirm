#!/usr/bin/env node
// Deploys AutoConfirm (API + dashboard) to one Cloudflare environment. Used by .github/workflows/deploy.yml.
//
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node tools/deploy/deploy.mjs --env staging
//   node tools/deploy/deploy.mjs --env production --dry-run     (no Cloudflare calls; checks the build)
//
// Optional env: AUTOCONFIRM_ADMIN_TOKEN (operator token, ≥ 32 chars), API_PUBLIC_URL / DASHBOARD_PUBLIC_URL
// (custom domains; default *.workers.dev), WORKERS_SUBDOMAIN (name for a new account's workers.dev subdomain).
//
// Safe to run again and again: it creates missing resources, never deletes, and never replaces existing
// encryption keys (that would make stored phone/webhook/MFA secrets unreadable).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const ENV = argv[argv.indexOf('--env') + 1];
const DRY = argv.includes('--dry-run');
if (!['staging', 'production'].includes(ENV)) die('usage: deploy.mjs --env staging|production [--dry-run]');

const SUFFIX = ENV === 'production' ? '' : '-staging';
const NAMES = {
	api: `autoconfirm-api${SUFFIX}`,
	dash: `autoconfirm-dashboard${SUFFIX}`,
	db: `autoconfirm${SUFFIX}`,
	kv: `autoconfirm-rules${SUFFIX}`,
	queue: `autoconfirm-webhooks${SUFFIX}`,
};
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!DRY && (!TOKEN || !ACCOUNT)) die('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set');

function die(msg) {
	console.error(`✗ ${msg}`);
	process.exit(1);
}
const step = (msg) => console.log(`\n▶ ${msg}`);

/** Cloudflare REST API (only for listing/creating resources). Never prints the token. */
async function cf(path, init = {}) {
	let res;
	let json;
	// Cloudflare sometimes rate-limits (HTTP 429 / code 971); wait as asked and try again.
	for (let attempt = 1; ; attempt++) {
		res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, {
			...init,
			headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
		});
		json = await res.json().catch(() => ({}));
		const throttled = res.status === 429 || (json.errors ?? []).some((e) => e.code === 971);
		if (!throttled || attempt >= 8) break;
		const wait = Math.min(Number(res.headers.get('retry-after')) || 10, 60);
		console.log(`  Cloudflare asked us to slow down; retrying in ${wait}s`);
		await new Promise((r) => setTimeout(r, wait * 1000));
	}
	if (!res.ok || json.success === false) {
		const errs = (json.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ');
		throw new Error(`Cloudflare API ${init.method ?? 'GET'} ${path.split('?')[0]} failed (${res.status}) ${errs}`);
	}
	return json;
}

async function ensureD1() {
	const list = await cf(`/d1/database?name=${encodeURIComponent(NAMES.db)}&per_page=100`);
	const found = (list.result ?? []).find((d) => d.name === NAMES.db);
	if (found) return found.uuid;
	console.log(`  creating D1 database ${NAMES.db}`);
	return (await cf('/d1/database', { method: 'POST', body: JSON.stringify({ name: NAMES.db }) })).result.uuid;
}

async function ensureKV() {
	for (let page = 1; page < 50; page++) {
		const list = await cf(`/storage/kv/namespaces?per_page=100&page=${page}`);
		const found = (list.result ?? []).find((n) => n.title === NAMES.kv);
		if (found) return found.id;
		if ((list.result ?? []).length < 100) break;
	}
	console.log(`  creating KV namespace ${NAMES.kv}`);
	return (await cf('/storage/kv/namespaces', { method: 'POST', body: JSON.stringify({ title: NAMES.kv }) })).result.id;
}

async function ensureQueue() {
	const list = await cf('/queues?per_page=100');
	if ((list.result ?? []).some((q) => q.queue_name === NAMES.queue)) return;
	console.log(`  creating queue ${NAMES.queue}`);
	await cf('/queues', { method: 'POST', body: JSON.stringify({ queue_name: NAMES.queue }) });
}

/** The account's workers.dev subdomain. New accounts have none yet, so we create one (WORKERS_SUBDOMAIN or a random name). */
async function workersSubdomain() {
	try {
		const sub = (await cf('/workers/subdomain')).result?.subdomain;
		if (sub) return sub;
	} catch {
		/* none yet */
	}
	const wanted = (process.env.WORKERS_SUBDOMAIN || `autoconfirm-${randomBytes(3).toString('hex')}`).toLowerCase();
	if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(wanted)) die(`WORKERS_SUBDOMAIN "${wanted}" is not a valid name (letters, digits, dashes)`);
	console.log(`  creating workers.dev subdomain ${wanted}`);
	try {
		return (await cf('/workers/subdomain', { method: 'PUT', body: JSON.stringify({ subdomain: wanted }) })).result.subdomain;
	} catch (e) {
		die(`Could not create the workers.dev subdomain (${e.message}). Open "Workers & Pages" in the Cloudflare dashboard, create any Hello World application once, then run again.`);
	}
}

/** wrangler.jsonc -> object: drops line and block comments outside strings, and trailing commas. */
function readJsonc(file) {
	const src = readFileSync(file, 'utf8');
	let out = '';
	let inStr = false;
	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (inStr) {
			out += ch;
			if (ch === '\\') out += src[++i];
			else if (ch === '"') inStr = false;
		} else if (ch === '"') {
			inStr = true;
			out += ch;
		} else if (ch === '/' && src[i + 1] === '/') {
			while (i < src.length && src[i] !== '\n') i++;
			out += '\n';
		} else if (ch === '/' && src[i + 1] === '*') {
			i = src.indexOf('*/', i + 2) + 1;
		} else out += ch;
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function wrangler(args, { input, allowFail = false } = {}) {
	const r = spawnSync('npx', ['--no', 'wrangler', ...args], {
		cwd: ROOT,
		input,
		stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'inherit'],
		encoding: 'utf8',
		env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
	});
	if (r.stdout) process.stdout.write(r.stdout);
	if (r.status !== 0 && !allowFail) die(`wrangler ${args[0]} ${args[1] ?? ''} failed`);
	return r;
}

function run(cmd, args) {
	const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
	if (r.status !== 0) die(`${cmd} ${args.join(' ')} failed`);
}

async function smoke(url, expect) {
	for (let i = 0; i < 12; i++) {
		try {
			const res = await fetch(url, { redirect: 'manual' });
			if (expect(res)) return true;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 5000));
	}
	return false;
}

async function main() {
	console.log(`AutoConfirm deploy → ${ENV}${DRY ? ' (dry run)' : ''}`);

	step('Cloudflare resources');
	const [dbId, kvId, sub] = DRY
		? ['00000000-0000-0000-0000-000000000000', '00000000000000000000000000000000', 'example']
		: [await ensureD1(), await ensureKV(), await workersSubdomain()];
	if (!DRY) await ensureQueue();
	const apiUrl = (process.env.API_PUBLIC_URL || `https://${NAMES.api}.${sub}.workers.dev`).replace(/\/$/, '');
	const dashUrl = (process.env.DASHBOARD_PUBLIC_URL || `https://${NAMES.dash}.${sub}.workers.dev`).replace(/\/$/, '');
	console.log(`  D1 ${NAMES.db}, KV ${NAMES.kv}, queue ${NAMES.queue}`);

	step('Generated wrangler configs');
	const api = readJsonc(join(ROOT, 'apps/api/wrangler.jsonc'));
	api.name = NAMES.api;
	api.workers_dev = true;
	api.d1_databases[0] = { ...api.d1_databases[0], database_name: NAMES.db, database_id: dbId };
	api.kv_namespaces[0] = { ...api.kv_namespaces[0], id: kvId };
	api.queues.producers[0].queue = NAMES.queue;
	api.queues.consumers[0].queue = NAMES.queue;
	api.vars = { ...api.vars, CHECKOUT_BASE_URL: apiUrl, PUBLIC_API_URL: apiUrl, DASHBOARD_URL: dashUrl };
	const apiConfig = join(ROOT, 'apps/api/wrangler.generated.json');
	writeFileSync(apiConfig, JSON.stringify(api, null, 2));

	const dash = readJsonc(join(ROOT, 'apps/dashboard/wrangler.jsonc'));
	dash.name = NAMES.dash;
	dash.workers_dev = true;
	dash.services = [{ binding: 'API', service: NAMES.api }];
	const dashConfig = join(ROOT, 'apps/dashboard/wrangler.generated.json');
	writeFileSync(dashConfig, JSON.stringify(dash, null, 2));
	console.log('  apps/api/wrangler.generated.json, apps/dashboard/wrangler.generated.json');

	if (!DRY) {
		step(`Database migrations (${NAMES.db})`);
		wrangler(['d1', 'migrations', 'apply', NAMES.db, '--remote', '-c', apiConfig]);
	}

	step(`Deploy API (${NAMES.api})`);
	wrangler(['deploy', '-c', apiConfig, ...(DRY ? ['--dry-run', '--outdir', join(tmpdir(), 'ac-api-dry')] : [])]);

	step('Parser rules (rules/parser-rules.json → KV "active")');
	const rulesFile = join(ROOT, 'rules/parser-rules.json');
	const rules = JSON.parse(readFileSync(rulesFile, 'utf8'));
	if (!rules.version || !Array.isArray(rules.apps) || rules.apps.length === 0) die('rules/parser-rules.json needs a version and at least one app');
	for (const app of rules.apps) {
		if (!/^[a-z0-9_]{2,40}$/.test(app.id ?? '') || !app.packages?.length || !app.incoming?.length) die(`rules: app "${app.id}" is incomplete`);
	}
	if (DRY) console.log(`  rules ${rules.version} are valid (${rules.apps.map((a) => a.id).join(', ')})`);
	else {
		wrangler(['kv', 'key', 'put', 'active', '--path', rulesFile, '--namespace-id', kvId, '--remote']);
		console.log(`  published rules ${rules.version}; phones pick them up within 15 min (or tap Retry in the app)`);
	}

	if (!DRY) {
		step('Secrets');
		const listed = wrangler(['secret', 'list', '-c', apiConfig, '--format', 'json'], { allowFail: true });
		let have = [];
		try {
			have = JSON.parse(listed.stdout || '[]').map((s) => s.name);
		} catch {
			have = [];
		}
		const put = {};
		for (const name of ['DEVICE_KEY', 'WEBHOOK_KEY', 'MFA_KEY']) {
			if (!have.includes(name)) put[name] = randomBytes(32).toString('base64'); // created once, never replaced
		}
		const admin = process.env.AUTOCONFIRM_ADMIN_TOKEN;
		if (admin && admin.length >= 32) put.ADMIN_TOKEN = admin;
		else if (!have.includes('ADMIN_TOKEN')) console.log('  ADMIN_TOKEN not set: the operator API (creating merchants) stays off.');
		if (Object.keys(put).length) {
			const dir = mkdtempSync(join(tmpdir(), 'ac-secrets-'));
			const file = join(dir, 'secrets.json');
			writeFileSync(file, JSON.stringify(put), { mode: 0o600 });
			try {
				wrangler(['secret', 'bulk', file, '-c', apiConfig]);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
			console.log(`  set: ${Object.keys(put).join(', ')}`);
		} else console.log('  all secrets already set');
	}

	step(`Build + deploy dashboard (${NAMES.dash})`);
	run('npm', ['run', 'build', '-w', '@autoconfirm/dashboard']);
	wrangler(['deploy', '-c', dashConfig, ...(DRY ? ['--dry-run', '--outdir', join(tmpdir(), 'ac-dash-dry')] : [])]);

	if (DRY) {
		console.log('\n✓ dry run finished: both Workers build and their configs are valid');
		return;
	}

	step('Smoke test');
	const checks = [
		['API', `${apiUrl}/`, (r) => r.status === 200],
		['checkout.js', `${apiUrl}/v1/checkout.js`, (r) => r.status === 200],
		['dashboard', `${dashUrl}/login`, (r) => r.status === 200],
	];
	let bad = 0;
	for (const [label, url, expect] of checks) {
		const ok = await smoke(url, expect);
		console.log(`  ${ok ? '✓' : '✗'} ${label} ${url}`);
		if (!ok) bad++;
	}
	const summary = `### AutoConfirm ${ENV}\n- API: ${apiUrl}\n- Dashboard: ${dashUrl}\n- Smoke test: ${bad ? `${bad} failed` : 'passed'}\n`;
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
	console.log(`\n${summary}`);
	if (bad) process.exit(1);
}

main().catch((e) => die(e.message));
