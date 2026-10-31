#!/usr/bin/env node
// Device simulator: pairs like the Android app and sends signed "money received" signals.
//
//   node tools/device-sim.mjs pair --code pc_xxx [--api http://localhost:8787]
//   node tools/device-sim.mjs signal --amount 930.07 [--app gpay_business] [--payer "Ramesh Patel"]
//   node tools/device-sim.mjs heartbeat
//
// Credentials are saved to .device-sim.json (git-ignored). Use test-mode pairing codes only.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const CREDS = '.device-sim.json';

function args(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
		else out._.push(a);
	}
	return out;
}

/** "930.07" -> 93007 without floating point. */
function toPaise(s) {
	const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(s).replace(/[₹,\s]/g, ''));
	if (!m) throw new Error(`bad amount: ${s}`);
	return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

async function signed(creds, method, path, bodyObj) {
	const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
	const timestamp = String(Math.floor(Date.now() / 1000));
	const nonce = 'n_' + randomBytes(12).toString('hex');
	const toSign = [method, path, timestamp, nonce, sha256(body)].join('\n');
	const signature = createHmac('sha256', creds.device_secret).update(toSign).digest('hex');
	const res = await fetch(creds.api + path, {
		method,
		headers: {
			'content-type': 'application/json',
			'x-device-id': creds.device_id,
			'x-timestamp': timestamp,
			'x-nonce': nonce,
			'x-signature': signature,
		},
		body: body || undefined,
	});
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null };
}

function load() {
	if (!existsSync(CREDS)) throw new Error(`no ${CREDS}; run "pair --code ..." first`);
	return JSON.parse(readFileSync(CREDS, 'utf8'));
}

async function main() {
	const a = args(process.argv.slice(2));
	const cmd = a._[0] ?? (a.amount ? 'signal' : 'help');

	if (cmd === 'pair') {
		const api = String(a.api ?? 'http://localhost:8787').replace(/\/$/, '');
		const res = await fetch(`${api}/device/v1/enroll`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ pairing_code: a.code, device_info: { label: 'Device simulator', model: 'device-sim' } }),
		});
		const body = await res.json();
		if (res.status !== 201) throw new Error(`enroll failed: ${JSON.stringify(body)}`);
		if (body.livemode) console.warn('warning: this is a LIVE device. The simulator is meant for test mode.');
		writeFileSync(CREDS, JSON.stringify({ api, ...body }, null, 2), { mode: 0o600 });
		console.log(`paired ${body.device_id} to ${body.location_id}; saved ${CREDS}`);
		await heartbeat(load());
		return;
	}
	if (cmd === 'heartbeat') return heartbeat(load());
	if (cmd === 'signal') {
		const creds = load();
		const signal = {
			app: String(a.app ?? 'phonepe_business'),
			amount_paise: toPaise(a.amount),
			payer_short: a.payer ? String(a.payer) : 'Test Payer',
			reference: a.utr ? String(a.utr) : undefined,
			posted_at: Date.now(),
			notification_key_hash: sha256(`${Date.now()}-${Math.random()}`).slice(0, 32),
		};
		const r = await signed(creds, 'POST', '/device/v1/signals', { signals: [signal] });
		console.log(r.status, JSON.stringify(r.body));
		return;
	}
	console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 9).join('\n'));
}

async function heartbeat(creds) {
	const r = await signed(creds, 'POST', '/device/v1/heartbeat', { device_time: Date.now(), listener_connected: true, app_version: 'sim' });
	console.log('heartbeat', r.status);
}

main().catch((e) => {
	console.error(e.message);
	process.exit(1);
});
