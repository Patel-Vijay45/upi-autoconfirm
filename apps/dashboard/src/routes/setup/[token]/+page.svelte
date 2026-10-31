<script lang="ts">
	let { data, form } = $props();
	const inv = $derived(data.invite);
</script>

<svelte:head><title>Set up your account · AutoConfirm</title></svelte:head>

<div class="wrap">
	<h1>Welcome to AutoConfirm</h1>
	<p>You're joining <strong>{inv.merchant_name}</strong> as <strong>{inv.role}</strong> ({inv.email}).</p>
	<form method="POST" class="card">
		{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
		<label><span>Choose a password (at least 10 characters)</span><input name="password" type="password" autocomplete="new-password" minlength="10" required /></label>
		<label><span>Type it again</span><input name="confirm" type="password" autocomplete="new-password" minlength="10" required /></label>

		<h2>{inv.mfa_required ? 'Set up your authenticator app' : 'Authenticator app (optional, recommended)'}</h2>
		<p class="small muted">Scan this with Google Authenticator, Microsoft Authenticator or a similar app, then enter the 6-digit code it shows.</p>
		<div class="qr">{@html inv.totp.qr_svg}</div>
		<p class="small">Can't scan? Enter this key: <span class="mono" data-testid="totp-secret">{inv.totp.secret}</span></p>
		<label><span>6-digit code</span><input name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required={inv.mfa_required} /></label>
		<button>Create my account</button>
	</form>
</div>

<style>
	.wrap { max-width: 28rem; margin: 2rem auto; }
	input { width: 100%; }
	button { width: 100%; margin-top: .5rem; }
</style>
