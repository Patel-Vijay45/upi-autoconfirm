import { hmacSha256Hex, sha256Hex, timingSafeEqual } from './crypto.ts';

// ---------- Webhooks: AutoConfirm-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)> ----------

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export async function signWebhook(secret: string, rawBody: string, nowSeconds: number): Promise<string> {
	const t = Math.floor(nowSeconds);
	return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${rawBody}`)}`;
}

export async function verifyWebhook(
	secret: string,
	rawBody: string,
	header: string | null | undefined,
	nowSeconds: number,
	toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS,
): Promise<boolean> {
	if (!header) return false;
	let t: number | undefined;
	const v1: string[] = [];
	for (const part of header.split(',')) {
		const [k, v] = part.trim().split('=', 2);
		if (k === 't' && v && /^\d+$/.test(v)) t = Number(v);
		if (k === 'v1' && v) v1.push(v);
	}
	if (t === undefined || v1.length === 0) return false;
	if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
	const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
	return v1.some((sig) => timingSafeEqual(sig, expected));
}

// ---------- Device requests (API.md §8) ----------
// X-Signature = hex(HMAC_SHA256(device_secret, method \n path \n timestamp \n nonce \n sha256_hex(body)))
// X-Timestamp is unix seconds.

export const DEVICE_SKEW_SECONDS = 300;
export const DEVICE_NONCE_TTL_SECONDS = 600;

export interface DeviceSignatureInput {
	method: string;
	path: string;
	timestamp: string;
	nonce: string;
	body: string;
}

export async function deviceSigningString(i: DeviceSignatureInput): Promise<string> {
	return [i.method.toUpperCase(), i.path, i.timestamp, i.nonce, await sha256Hex(i.body)].join('\n');
}

export async function signDeviceRequest(secret: string, i: DeviceSignatureInput): Promise<string> {
	return hmacSha256Hex(secret, await deviceSigningString(i));
}

export type DeviceVerifyResult = { ok: true } | { ok: false; reason: 'bad_timestamp' | 'clock_skew' | 'bad_nonce' | 'bad_signature' };

/** Checks timestamp window and HMAC. Nonce replay must be checked separately by the caller (it needs storage). */
export async function verifyDeviceRequest(
	secret: string,
	i: DeviceSignatureInput,
	signature: string,
	nowSeconds: number,
): Promise<DeviceVerifyResult> {
	if (!/^\d{9,11}$/.test(i.timestamp)) return { ok: false, reason: 'bad_timestamp' };
	if (Math.abs(nowSeconds - Number(i.timestamp)) > DEVICE_SKEW_SECONDS) return { ok: false, reason: 'clock_skew' };
	if (!/^[A-Za-z0-9_-]{16,64}$/.test(i.nonce)) return { ok: false, reason: 'bad_nonce' };
	const expected = await signDeviceRequest(secret, i);
	return timingSafeEqual(signature, expected) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}
