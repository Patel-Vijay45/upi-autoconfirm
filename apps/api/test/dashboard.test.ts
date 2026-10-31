import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { totpAt, totpStep } from '@autoconfirm/core';
import { ADMIN, call, createIntent, deviceCall, newMerchant, sendSignal, setup } from './helpers.ts';

const PASSWORD = 'correct horse battery';

/** Invite a user through the operator API and finish setup. Returns a session and the TOTP secret. */
async function userFor(merchantId: string, email: string, role: 'owner' | 'admin' | 'staff' | 'developer') {
	const inv = await call('POST', `/admin/v1/merchants/${merchantId}/invites`, { key: ADMIN, body: { email, role } });
	expect(inv.status).toBe(201);
	const info = await call('GET', `/dashboard/v1/invites/${inv.json.token}`);
	const secret: string = info.json.totp.secret;
	const otp = role === 'owner' || role === 'admin' ? await totpAt(secret, totpStep(Date.now())) : undefined;
	const done = await call('POST', `/dashboard/v1/invites/${inv.json.token}`, { body: { password: PASSWORD, ...(otp ? { otp } : {}) } });
	expect(done.status).toBe(201);
	return { token: done.json.token as string, secret, userId: done.json.user.id as string, invite: inv.json };
}

const as = (token: string, mode: 'test' | 'live' = 'test') => ({ key: token, headers: { 'autoconfirm-mode': mode } });
let n = 0;
const email = (p: string) => `${p}${++n}@shop.example`;

describe('invites and login', () => {
	it('owner setup needs an authenticator code; then the session works on merchant routes', async () => {
		const { keys } = await setup();
		const inv = await call('POST', `/admin/v1/merchants/${keys.merchantId}/invites`, { key: ADMIN, body: { email: email('owner'), role: 'owner' } });
		expect(inv.json.setup_url).toBe(`https://dash.example.com/setup/${inv.json.token}`);
		const info = await call('GET', `/dashboard/v1/invites/${inv.json.token}`);
		expect(info.json).toMatchObject({ role: 'owner', mfa_required: true, merchant_name: 'Test merchant' });
		expect(info.json.totp.otpauth_uri).toContain(`secret=${info.json.totp.secret}`);
		expect(info.json.totp.qr_svg).toContain('<svg');
		expect((await call('POST', `/dashboard/v1/invites/${inv.json.token}`, { body: { password: PASSWORD } })).json.error.code).toBe('otp_required');
		expect((await call('POST', `/dashboard/v1/invites/${inv.json.token}`, { body: { password: PASSWORD, otp: '000000' } })).json.error.code).toBe('invalid_otp');
		expect((await call('POST', `/dashboard/v1/invites/${inv.json.token}`, { body: { password: 'short', otp: '000000' } })).status).toBe(400);
		const otp = await totpAt(info.json.totp.secret, totpStep(Date.now()));
		const done = await call('POST', `/dashboard/v1/invites/${inv.json.token}`, { body: { password: PASSWORD, otp } });
		expect(done.status).toBe(201);
		// The link works once.
		expect((await call('GET', `/dashboard/v1/invites/${inv.json.token}`)).status).toBe(404);
		const me = await call('GET', '/dashboard/v1/me', as(done.json.token));
		expect(me.json).toMatchObject({ user: { role: 'owner', mfa: true }, merchant: { id: keys.merchantId }, livemode: false });
		const pi = (await createIntent(keys.sk)).json;
		expect((await call('GET', `/v1/payment_intents/${pi.id}`, as(done.json.token))).json.id).toBe(pi.id);
		// The session uses the chosen mode: a test intent is invisible in live mode.
		expect((await call('GET', `/v1/payment_intents/${pi.id}`, as(done.json.token, 'live'))).status).toBe(404);
	});

	it('login: password, then a fresh TOTP code; codes cannot be replayed; logout ends the session', async () => {
		const keys = await newMerchant();
		const e = email('admin');
		const u = await userFor(keys.merchantId, e, 'admin');
		expect((await call('POST', '/dashboard/v1/login', { body: { email: e, password: 'wrong password' } })).json.error.code).toBe('invalid_login');
		expect((await call('POST', '/dashboard/v1/login', { body: { email: 'nobody@x.example', password: PASSWORD } })).json.error.code).toBe('invalid_login');
		expect((await call('POST', '/dashboard/v1/login', { body: { email: e.toUpperCase(), password: PASSWORD } })).json.error.code).toBe('otp_required');
		const otp = await totpAt(u.secret, totpStep(Date.now()) + 1); // the setup step was used already
		const ok = await call('POST', '/dashboard/v1/login', { body: { email: e, password: PASSWORD, otp } });
		expect(ok.status).toBe(200);
		expect(ok.json.token).toMatch(/^ses_/);
		expect((await call('POST', '/dashboard/v1/login', { body: { email: e, password: PASSWORD, otp } })).json.error.code).toBe('invalid_otp');
		await call('POST', '/dashboard/v1/logout', as(ok.json.token));
		expect((await call('GET', '/dashboard/v1/me', as(ok.json.token))).status).toBe(401);
	});

	it('locks an email after 5 failed logins', async () => {
		const keys = await newMerchant();
		const e = email('staff');
		await userFor(keys.merchantId, e, 'staff');
		for (let k = 0; k < 5; k++) expect((await call('POST', '/dashboard/v1/login', { body: { email: e, password: 'nope nope nope' } })).status).toBe(401);
		const r = await call('POST', '/dashboard/v1/login', { body: { email: e, password: PASSWORD } });
		expect(r.status).toBe(429);
	});

	it('staff can log in with a password only (no MFA required)', async () => {
		const keys = await newMerchant();
		const e = email('staff');
		await userFor(keys.merchantId, e, 'staff');
		expect((await call('POST', '/dashboard/v1/login', { body: { email: e, password: PASSWORD } })).status).toBe(200);
	});

	it('an email can only have one account', async () => {
		const a = await newMerchant();
		const b = await newMerchant();
		const e = email('dup');
		await userFor(a.merchantId, e, 'staff');
		expect((await call('POST', `/admin/v1/merchants/${b.merchantId}/invites`, { key: ADMIN, body: { email: e, role: 'owner' } })).json.error.code).toBe('email_in_use');
	});
});

describe('roles', () => {
	it('staff handle payments; only owners/admins manage the shop', async () => {
		const { keys, device, locationId } = await setup();
		const staff = await userFor(keys.merchantId, email('staff'), 'staff');
		const pi = (await createIntent(keys.sk)).json;
		expect((await call('POST', `/v1/payment_intents/${pi.id}/mark_paid`, { ...as(staff.token), body: { note: 'soundbox' } })).json.status).toBe('paid');
		const audit = await env.DB.prepare("SELECT actor FROM audit_log WHERE merchant_id = ? AND action = 'intent.mark_paid'").bind(keys.merchantId).first<{ actor: string }>();
		expect(audit!.actor).toBe(`user:${staff.userId}`);
		for (const [m, p, body] of [
			['POST', '/v1/locations', { name: 'X', upi_vpa: 'x@ybl', upi_payee_name: 'X' }],
			['POST', `/v1/locations/${locationId}/pairing_codes`, undefined],
			['POST', `/v1/devices/${device.id}/revoke`, undefined],
			['GET', '/v1/users', undefined],
			['GET', '/v1/api_keys', undefined],
			['POST', '/v1/settings', { auto_confirm_max: 1000 }],
			['GET', '/v1/audit_log', undefined],
			['GET', '/v1/webhook_endpoints', undefined],
		] as const) {
			expect((await call(m, p, { ...as(staff.token), body })).status, `${m} ${p}`).toBe(403);
		}
	});

	it('developers create test keys (shown once) but not live keys; keys cannot manage keys', async () => {
		const keys = await newMerchant();
		const dev = await userFor(keys.merchantId, email('dev'), 'developer');
		const k = await call('POST', '/v1/api_keys', { ...as(dev.token), body: { kind: 'secret' } });
		expect(k.status).toBe(201);
		expect(k.json.key).toMatch(/^sk_test_/);
		const list = await call('GET', '/v1/api_keys', as(dev.token));
		expect(JSON.stringify(list.json)).not.toContain(k.json.key);
		expect(list.json.data.find((x: { id: string }) => x.id === k.json.id).prefix).toBe(k.json.key.slice(0, 12));
		expect((await call('GET', '/v1/locations', { key: k.json.key })).status).toBe(200);
		expect((await call('POST', `/v1/api_keys/${k.json.id}/revoke`, as(dev.token))).status).toBe(200);
		expect((await call('GET', '/v1/locations', { key: k.json.key })).status).toBe(401);
		expect((await call('POST', '/v1/api_keys', { ...as(dev.token, 'live'), body: { kind: 'secret' } })).status).toBe(403);
		expect((await call('POST', '/v1/api_keys', { key: keys.sk, body: { kind: 'secret' } })).status).toBe(403);
	});

	it('an owner deactivates a user, whose sessions end at once', async () => {
		const keys = await newMerchant();
		const owner = await userFor(keys.merchantId, email('owner'), 'owner');
		const staff = await userFor(keys.merchantId, email('staff'), 'staff');
		expect((await call('POST', `/v1/users/${owner.userId}/deactivate`, as(owner.token))).json.error.code).toBe('cannot_deactivate_self');
		expect((await call('POST', `/v1/users/${staff.userId}/deactivate`, as(owner.token))).status).toBe(200);
		expect((await call('GET', '/dashboard/v1/me', as(staff.token))).status).toBe(401);
		const users = await call('GET', '/v1/users', as(owner.token));
		expect(users.json.data.find((u: { id: string }) => u.id === staff.userId).active).toBe(false);
	});

	it('owners invite team members; admins cannot invite owners', async () => {
		const keys = await newMerchant();
		const admin = await userFor(keys.merchantId, email('admin'), 'admin');
		expect((await call('POST', '/v1/users/invites', { ...as(admin.token), body: { email: email('o'), role: 'owner' } })).status).toBe(403);
		const inv = await call('POST', '/v1/users/invites', { ...as(admin.token), body: { email: email('s'), role: 'staff' } });
		expect(inv.status).toBe(201);
		expect(inv.json.token).toMatch(/^inv_/);
	});
});

describe('dashboard features', () => {
	it('phones: list with status, revoke stops the phone', async () => {
		const { keys, device, locationId } = await setup();
		const owner = await userFor(keys.merchantId, email('owner'), 'owner');
		let list = await call('GET', `/v1/devices?location_id=${locationId}`, as(owner.token));
		expect(list.json.data[0]).toMatchObject({ id: device.id, status: 'pending' });
		await deviceCall(device, 'POST', '/device/v1/heartbeat', { device_time: Date.now(), listener_connected: true, battery_optimized: true });
		list = await call('GET', '/v1/devices', as(owner.token));
		expect(list.json.data[0]).toMatchObject({ status: 'online', listener_enabled: true, battery_optimized: true });
		expect((await call('POST', `/v1/devices/${device.id}/revoke`, as(owner.token))).json.status).toBe('revoked');
		expect((await deviceCall(device, 'POST', '/device/v1/heartbeat', { device_time: Date.now(), listener_connected: true })).status).toBe(401);
	});

	it('locations can be renamed and paused', async () => {
		const { keys, locationId } = await setup();
		const r = await call('POST', `/v1/locations/${locationId}`, { key: keys.sk, body: { name: 'Front counter', active: false } });
		expect(r.json).toMatchObject({ name: 'Front counter', active: false });
		expect((await createIntent(keys.sk)).json.error.code).toBe('location_not_ready');
	});

	it('settings change matching: a lower auto_confirm_max sends big payments to review', async () => {
		const { keys, device } = await setup();
		const owner = await userFor(keys.merchantId, email('owner'), 'owner');
		expect((await call('GET', '/v1/settings', as(owner.token))).json).toMatchObject({ auto_confirm_max: null, intent_ttl: 900, reuse_cooldown: 3600 });
		const s = await call('POST', '/v1/settings', { ...as(owner.token), body: { auto_confirm_max: 50000, intent_ttl: 1800 } });
		expect(s.json).toMatchObject({ auto_confirm_max: 50000, intent_ttl: 1800 });
		expect((await call('POST', '/v1/settings', { ...as(owner.token), body: { reuse_cooldown: 60 } })).status).toBe(400); // never below 10 min
		const pi = (await createIntent(keys.sk, { amount: 93000 })).json;
		expect(Date.parse(pi.expires_at) - Date.parse(pi.created)).toBe(1800_000);
		expect((await sendSignal(device, pi.unique_amount)).json.results[0].status).toBe('review');
		// A secret key can read but not change settings.
		expect((await call('POST', '/v1/settings', { key: keys.sk, body: { auto_confirm_max: null } })).status).toBe(403);
	});

	it('inbox suggestions point to the closest open intents at the same location', async () => {
		const { keys, device } = await setup();
		const a = (await createIntent(keys.sk, { amount: 93000, order_id: 'A' })).json;
		await createIntent(keys.sk, { amount: 50000, order_id: 'B' });
		const sig = (await sendSignal(device, 93000)).json.results[0].signal_id;
		const d = await call('GET', `/v1/signals/${sig}`, { key: keys.sk });
		expect(d.json.suggestions[0]).toMatchObject({ id: a.id, order_id: 'A' });
	});

	it('reports: daily totals and a CSV that blocks spreadsheet formulas', async () => {
		const { keys, device } = await setup();
		const p1 = (await createIntent(keys.sk, { amount: 93000, order_id: '=HYPERLINK("x")' })).json;
		await sendSignal(device, p1.unique_amount);
		const p2 = (await createIntent(keys.sk, { amount: 50000 })).json;
		await call('POST', `/v1/payment_intents/${p2.id}/mark_paid`, { key: keys.sk, body: {} });
		await sendSignal(device, 1234); // unmatched
		const r = await call('GET', '/v1/reports/summary', { key: keys.sk });
		expect(r.json.total).toMatchObject({ paid_count: 2, auto_count: 1, open_inbox: 1, received: p1.unique_amount + p2.unique_amount });
		const res = await (await import('../src/app.ts')).app.request('/v1/reports/payments.csv', { headers: { authorization: `Bearer ${keys.sk}` } }, env);
		expect(res.headers.get('content-type')).toContain('text/csv');
		const text = await res.text();
		expect(text.split('\r\n')[0]).toBe('payment_id,order_id,status,amount_inr,pay_amount_inr,received_inr,created_ist,paid_ist,source,late,amount_mismatch,location');
		expect(text).toContain(`${p1.id},"'=HYPERLINK(""x"")",paid,930.00,${p1.display_amount},${p1.display_amount}`);
		expect((await call('GET', '/v1/reports/summary?from=2026-01-01&to=2026-12-31', { key: keys.sk })).json.error.code).toBe('range_too_large');
	});

	it('webhooks: disable/enable, event list, resend, delivery log', async () => {
		const { keys, device } = await setup();
		const ep = (await call('POST', '/v1/webhook_endpoints', { key: keys.sk, body: { url: 'https://shop.example/hook', events: ['*'] } })).json;
		expect((await call('POST', `/v1/webhook_endpoints/${ep.id}/disable`, { key: keys.sk })).json.enabled).toBe(false);
		expect((await call('POST', `/v1/webhook_endpoints/${ep.id}/enable`, { key: keys.sk })).json.enabled).toBe(true);
		const pi = (await createIntent(keys.sk)).json;
		await sendSignal(device, pi.unique_amount);
		const events = await call('GET', '/v1/events?type=payment_intent.paid', { key: keys.sk });
		expect(events.json.data[0]).toMatchObject({ type: 'payment_intent.paid', object_id: pi.id });
		expect((await call('POST', `/v1/events/${events.json.data[0].id}/resend`, { key: keys.sk })).json.resent).toBe(true);
		await env.DB.prepare("INSERT INTO webhook_deliveries (merchant_id, event_id, endpoint_id, attempt, status, http_status, created_at) VALUES (?, ?, ?, 1, 'failed', 500, ?)")
			.bind(keys.merchantId, events.json.data[0].id, ep.id, Date.now())
			.run();
		const log = await call('GET', `/v1/webhook_deliveries?endpoint_id=${ep.id}`, { key: keys.sk });
		expect(log.json.data[0]).toMatchObject({ type: 'payment_intent.paid', status: 'failed', http_status: 500 });
	});

	it('audit log shows who did what, by email', async () => {
		const keys = await newMerchant();
		const owner = await userFor(keys.merchantId, email('owner'), 'owner');
		await call('POST', '/v1/settings', { ...as(owner.token), body: { max_offset: 50 } });
		const log = await call('GET', '/v1/audit_log', as(owner.token));
		expect(log.json.data[0]).toMatchObject({ action: 'settings.update', detail: { max_offset: 50 } });
		expect(log.json.data[0].actor).toMatch(/^owner\d+@shop\.example$/);
	});
});

describe('tenancy: dashboard endpoints never cross merchants', () => {
	it('merchant B (session or key) cannot see or change merchant A', async () => {
		const a = await setup();
		const b = await setup();
		const aOwner = await userFor(a.keys.merchantId, email('aowner'), 'owner');
		const bOwner = await userFor(b.keys.merchantId, email('bowner'), 'owner');
		const aStaff = await userFor(a.keys.merchantId, email('astaff'), 'staff');
		const aKey = (await call('POST', '/v1/api_keys', { ...as(aOwner.token), body: { kind: 'secret' } })).json;
		const aEp = (await call('POST', '/v1/webhook_endpoints', { key: a.keys.sk, body: { url: 'https://a.example/hook', events: ['*'] } })).json;
		const pi = (await createIntent(a.keys.sk)).json;
		await sendSignal(a.device, pi.unique_amount);
		const aEvent = (await call('GET', '/v1/events', { key: a.keys.sk })).json.data[0].id;
		await call('POST', '/v1/settings', { ...as(aOwner.token), body: { max_offset: 40 } });

		for (const B of [as(bOwner.token), { key: b.keys.sk }]) {
			const write404 = async (path: string, body: unknown = {}) => {
				const r = await call('POST', path, { ...B, body });
				expect([403, 404], `POST ${path} -> ${r.status}`).toContain(r.status);
			};
			await write404(`/v1/users/${aStaff.userId}/deactivate`);
			await write404(`/v1/api_keys/${aKey.id}/revoke`);
			await write404(`/v1/devices/${a.device.id}/revoke`);
			await write404(`/v1/locations/${a.locationId}`, { name: 'hacked' });
			await write404(`/v1/webhook_endpoints/${aEp.id}/disable`);
			await write404(`/v1/events/${aEvent}/resend`);

			const lists: [string, string][] = [
				['/v1/devices', a.device.id],
				['/v1/events', aEvent],
				['/v1/webhook_deliveries', aEvent],
				['/v1/reports/summary', '"paid_count":1'],
			];
			for (const [path, needle] of lists) {
				const r = await call('GET', path, B);
				expect(JSON.stringify(r.json), path).not.toContain(needle);
			}
			expect((await call('GET', '/v1/settings', B)).json.max_offset).toBe(99);
		}
		const bUsers = await call('GET', '/v1/users', as(bOwner.token));
		expect(bUsers.json.data.map((u: { email: string }) => u.email)).toEqual([expect.stringMatching(/^bowner/)]);
		const bKeys = await call('GET', '/v1/api_keys', as(bOwner.token));
		expect(JSON.stringify(bKeys.json)).not.toContain(aKey.id);
		const bAudit = await call('GET', '/v1/audit_log', as(bOwner.token));
		expect(JSON.stringify(bAudit.json)).not.toContain(a.keys.merchantId);
		expect(bAudit.json.data).toHaveLength(0);
		// A is untouched.
		expect((await call('GET', '/v1/locations', { key: a.keys.sk })).json.data[0].name).toBe('Counter 1');
		expect((await call('GET', '/dashboard/v1/me', as(aStaff.token))).status).toBe(200);
		expect((await call('GET', '/v1/locations', { key: aKey.key })).status).toBe(200);
		// The operator invite endpoint needs the operator token.
		expect((await call('POST', `/admin/v1/merchants/${a.keys.merchantId}/invites`, { ...as(bOwner.token), body: { email: email('x'), role: 'owner' } })).status).toBe(401);
	});
});
