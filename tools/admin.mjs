#!/usr/bin/env node
// Operator tool: create a merchant (shop) and an owner invite link, until self-serve signup exists.
//
//   AUTOCONFIRM_ADMIN_TOKEN=… node tools/admin.mjs create-merchant --api https://autoconfirm-api.<sub>.workers.dev \
//       --name "My Shop" --owner you@example.com
//   AUTOCONFIRM_ADMIN_TOKEN=… node tools/admin.mjs invite --api … --merchant mer_… --email x@example.com --role staff
//
// The API keys are printed once. Store them in your project's server secrets; they can't be shown again.
const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (name) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};
const API = (arg('api') ?? process.env.AUTOCONFIRM_API ?? '').replace(/\/$/, '');
const TOKEN = process.env.AUTOCONFIRM_ADMIN_TOKEN;

function die(msg) {
	console.error(msg);
	process.exit(1);
}
if (!API || !TOKEN) die('Set --api <API URL> and the AUTOCONFIRM_ADMIN_TOKEN environment variable.');

async function call(path, body) {
	const res = await fetch(API + path, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
	const json = await res.json().catch(() => ({}));
	if (!res.ok) die(`${path} failed (${res.status}): ${json?.error?.message ?? 'unknown error'}`);
	return json;
}

if (cmd === 'create-merchant') {
	const name = arg('name');
	const owner = arg('owner');
	if (!name || !owner) die('Need --name "Shop name" and --owner email');
	const m = await call('/admin/v1/merchants', { name });
	const inv = await call(`/admin/v1/merchants/${m.merchant.id}/invites`, { email: owner, role: 'owner' });
	console.log(`Merchant: ${m.merchant.name} (${m.merchant.id})\n`);
	console.log('API keys (shown once, store them safely):');
	console.log(`  test secret       ${m.secret_key_test}`);
	console.log(`  test publishable  ${m.publishable_key_test}`);
	console.log(`  live secret       ${m.secret_key_live}`);
	console.log(`  live publishable  ${m.publishable_key_live}\n`);
	console.log(`Owner setup link for ${owner} (valid 72 h, works once):\n  ${inv.setup_url ?? `<dashboard>/setup/${inv.token}`}`);
} else if (cmd === 'invite') {
	const merchant = arg('merchant');
	const email = arg('email');
	const role = arg('role') ?? 'staff';
	if (!merchant || !email) die('Need --merchant mer_… and --email');
	const inv = await call(`/admin/v1/merchants/${merchant}/invites`, { email, role });
	console.log(`Setup link for ${email} (${role}, valid 72 h):\n  ${inv.setup_url ?? `<dashboard>/setup/${inv.token}`}`);
} else {
	die('Commands: create-merchant, invite');
}
