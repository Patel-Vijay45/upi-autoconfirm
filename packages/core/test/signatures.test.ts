import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, sha256Hex } from '../src/crypto.ts';
import { signDeviceRequest, signWebhook, verifyDeviceRequest, verifyWebhook } from '../src/signatures.ts';
import { randomId, randomSecret } from '../src/ids.ts';

const SECRET = 'whsec_test_secret';
const BODY = '{"id":"evt_1","type":"payment_intent.paid"}';
const NOW = 1_793_452_051;

describe('webhook signatures', () => {
	it('accepts a valid signature', async () => {
		const h = await signWebhook(SECRET, BODY, NOW);
		expect(h).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
		expect(await verifyWebhook(SECRET, BODY, h, NOW)).toBe(true);
		expect(await verifyWebhook(SECRET, BODY, h, NOW + 300)).toBe(true);
	});

	it('rejects wrong secret, tampered body, old timestamp, missing header', async () => {
		const h = await signWebhook(SECRET, BODY, NOW);
		expect(await verifyWebhook('other', BODY, h, NOW)).toBe(false);
		expect(await verifyWebhook(SECRET, BODY + ' ', h, NOW)).toBe(false);
		expect(await verifyWebhook(SECRET, BODY, h, NOW + 301)).toBe(false);
		expect(await verifyWebhook(SECRET, BODY, null, NOW)).toBe(false);
		expect(await verifyWebhook(SECRET, BODY, 'garbage', NOW)).toBe(false);
	});
});

describe('device signatures', () => {
	const req = { method: 'POST', path: '/device/v1/signals', timestamp: String(NOW), nonce: 'n_0123456789abcdef', body: '{"signals":[]}' };

	it('accepts a valid request', async () => {
		const sig = await signDeviceRequest('devsecret', req);
		expect(await verifyDeviceRequest('devsecret', req, sig, NOW)).toEqual({ ok: true });
	});

	it('rejects wrong body hash, clock skew and bad nonce', async () => {
		const sig = await signDeviceRequest('devsecret', req);
		expect(await verifyDeviceRequest('devsecret', { ...req, body: '{}' }, sig, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
		expect(await verifyDeviceRequest('devsecret', req, sig, NOW + 301)).toEqual({ ok: false, reason: 'clock_skew' });
		expect(await verifyDeviceRequest('devsecret', { ...req, nonce: 'short' }, sig, NOW)).toEqual({ ok: false, reason: 'bad_nonce' });
	});
});

describe('secrets and ids', () => {
	it('encrypts and decrypts with AES-GCM', async () => {
		const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
		const sealed = await encryptSecret(key, 'device-secret');
		expect(sealed).not.toContain('device-secret');
		expect(await decryptSecret(key, sealed)).toBe('device-secret');
	});

	it('makes unguessable ids and secrets', async () => {
		expect(randomId('pi')).toMatch(/^pi_[a-z2-7]{20}$/);
		expect(randomSecret()).toMatch(/^[0-9A-Za-z]{43}$/);
		expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	});
});
