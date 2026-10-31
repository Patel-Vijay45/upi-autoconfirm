<script lang="ts">
	let { form } = $props();
	const f = $derived(form as any);
</script>

<svelte:head><title>Operator · AutoConfirm</title></svelte:head>

<div class="wrap">
	<h1>Operator</h1>
	<p class="muted small">For the person running this AutoConfirm service. You need the operator token (the API's <span class="mono">ADMIN_TOKEN</span>). It is used for this one request and never stored.</p>

	{#if f?.shop}
		<div class="card" role="status">
			<h2>✓ Shop created: {f.shop.name}</h2>
			<p class="small muted">ID <span class="mono">{f.shop.id}</span></p>
			<div class="notice">
				<strong>Owner setup link for {f.email}</strong> (works once, valid 72 hours). Open it on the owner's phone to set a password and the authenticator app:
				<p class="mono" data-testid="setup-url"><a href={f.setupUrl}>{f.setupUrl}</a></p>
			</div>
			<div class="secret">
				<strong>API keys: shown only now.</strong> Put the secret keys in your project's server settings. You can also create new keys later in the dashboard under Developers.
				<table class="small">
					<tbody>
						<tr><th>Test secret</th><td class="mono" data-testid="sk-test">{f.keys.secret_test}</td></tr>
						<tr><th>Test publishable</th><td class="mono">{f.keys.publishable_test}</td></tr>
						<tr><th>Live secret</th><td class="mono">{f.keys.secret_live}</td></tr>
						<tr><th>Live publishable</th><td class="mono">{f.keys.publishable_live}</td></tr>
					</tbody>
				</table>
			</div>
		</div>
	{/if}

	{#if f?.action === 'invite' && f?.setupUrl}
		<div class="card notice" role="status">
			<strong>Setup link for {f.email} ({f.role})</strong> (works once, valid 72 hours):
			<p class="mono" data-testid="invite-url"><a href={f.setupUrl}>{f.setupUrl}</a></p>
		</div>
	{/if}

	<form method="POST" action="?/createShop" class="card" autocomplete="off">
		<h2>Create a shop</h2>
		{#if f?.action === 'createShop' && f?.error}<p class="error" role="alert">{f.error}</p>{/if}
		<label><span>Operator token</span><input name="token" type="password" required autocomplete="off" /></label>
		<label><span>Shop name</span><input name="name" required maxlength="100" defaultValue={f?.action === 'createShop' && f?.error ? (f?.name ?? '') : ''} /></label>
		<label><span>Owner's email (their dashboard login)</span><input name="email" type="email" required defaultValue={f?.action === 'createShop' && f?.error ? (f?.email ?? '') : ''} /></label>
		<button>Create shop</button>
	</form>

	<form method="POST" action="?/invite" class="card" autocomplete="off">
		<h2>Invite someone to an existing shop</h2>
		{#if f?.action === 'invite' && f?.error}<p class="error" role="alert">{f.error}</p>{/if}
		<label><span>Operator token</span><input name="token" type="password" required autocomplete="off" /></label>
		<label><span>Shop ID (mer_…)</span><input name="merchant" required defaultValue={f?.action === 'invite' && f?.error ? (f?.merchant ?? '') : ''} /></label>
		<label><span>Email</span><input name="email" type="email" required defaultValue={f?.action === 'invite' && f?.error ? (f?.email ?? '') : ''} /></label>
		<label>
			<span>Role</span>
			<select name="role"><option value="owner">Owner</option><option value="admin">Admin</option><option value="staff" selected>Staff</option><option value="developer">Developer</option></select>
		</label>
		<button class="ghost">Create invite link</button>
	</form>
</div>

<style>
	.wrap { max-width: 36rem; margin: 1.5rem auto; }
	input, select { width: 100%; }
	th { width: 9rem; }
</style>
