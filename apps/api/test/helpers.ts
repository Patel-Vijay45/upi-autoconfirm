import { env } from 'cloudflare:test';
import { randomId, sha256Hex, signDeviceRequest } from '@autoconfirm/core';
import { app } from '../src/app.ts';

export const ADMIN = 'test-admin-token-0123456789abcdef0123';

export interface CallResult<T = any> {
	status: number;
	json: T;
}

export async function call<T = any>(
	method: string,
	path: string,
	opts: { key?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<CallResult<T>> {
	const headers: Record<string, string> = { ...(opts.headers ?? {}) };
	if (opts.key) headers.authorization = `Bearer ${opts.key}`;
	let body: string | undefined;
	if (opts.body !== undefined) {
		body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
		headers['content-type'] = 'application/json';
	}
	const res = await app.request(path, { method, headers, body }, env);
	const text = await res.text();
	return { status: res.status, json: text ? JSON.parse(text) : null };
}

export interface Keys {
	merchantId: string;
	sk: string;
	pk: string;
	skLive: string;
	pkLive: string;
}

export async function newMerchant(settings?: Record<string, unknown>): Promise<Keys> {
	const r = await call('POST', '/admin/v1/merchants', { key: ADMIN, body: { name: 'Test merchant', ...(settings ? { settings } : {}) } });
	if (r.status !== 201) throw new Error(`merchant create failed: ${JSON.stringify(r.json)}`);
	return {
		merchantId: r.json.merchant.id,
		sk: r.json.secret_key_test,
		pk: r.json.publishable_key_test,
		skLive: r.json.secret_key_live,
		pkLive: r.json.publishable_key_live,
	};
}

export interface Device {
	id: string;
	secret: string;
	locationId: string;
}

export async function newLocation(sk: string, name = 'Counter 1'): Promise<string> {
	const r = await call('POST', '/v1/locations', { key: sk, body: { name, upi_vpa: 'shop@ybl', upi_payee_name: 'My Shop' } });
	if (r.status !== 201) throw new Error(`location create failed: ${JSON.stringify(r.json)}`);
	return r.json.id;
}

export async function pairDevice(sk: string, locationId: string): Promise<Device> {
	const pc = await call('POST', `/v1/locations/${locationId}/pairing_codes`, { key: sk });
	const r = await call('POST', '/device/v1/enroll', { body: { pairing_code: pc.json.code, device_info: { label: 'Counter phone' } } });
	if (r.status !== 201) throw new Error(`enroll failed: ${JSON.stringify(r.json)}`);
	return { id: r.json.device_id, secret: r.json.device_secret, locationId };
}

/** Merchant with one location and one paired phone (test mode). */
export async function setup(settings?: Record<string, unknown>) {
	const keys = await newMerchant(settings);
	const locationId = await newLocation(keys.sk);
	const device = await pairDevice(keys.sk, locationId);
	return { keys, locationId, device };
}

export async function deviceCall(
	device: Device,
	method: string,
	path: string,
	body: unknown,
	over: { timestamp?: number; nonce?: string; signature?: string; secret?: string } = {},
): Promise<CallResult> {
	const raw = body === undefined ? '' : JSON.stringify(body);
	const timestamp = String(over.timestamp ?? Math.floor(Date.now() / 1000));
	const nonce = over.nonce ?? randomId('n', 24);
	const url = new URL(path, 'http://localhost');
	const signature =
		over.signature ?? (await signDeviceRequest(over.secret ?? device.secret, { method, path: url.pathname + url.search, timestamp, nonce, body: raw }));
	return call(method, path, {
		body: body === undefined ? undefined : raw,
		headers: { 'x-device-id': device.id, 'x-timestamp': timestamp, 'x-nonce': nonce, 'x-signature': signature },
	});
}

let n = 0;
export async function sendSignal(device: Device, amountPaise: number, over: Record<string, unknown> = {}) {
	n++;
	return deviceCall(device, 'POST', '/device/v1/signals', {
		signals: [
			{
				app: 'phonepe_business',
				amount_paise: amountPaise,
				payer_short: 'Ramesh Patel',
				posted_at: Date.now(),
				notification_key_hash: (await sha256Hex(`key-${n}-${Math.random()}`)).slice(0, 32),
				...over,
			},
		],
	});
}

export async function createIntent(sk: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
	return call('POST', '/v1/payment_intents', { key: sk, body: { amount: 93000, order_id: 'ORD-1042', ...body }, headers });
}
