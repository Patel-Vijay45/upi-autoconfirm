<script lang="ts">
	import { enhance } from '$app/forms';
	let { form } = $props();
	let busy = $state(false);
</script>

<svelte:head><title>Log in · AutoConfirm</title></svelte:head>

<div class="wrap">
	<h1>AutoConfirm</h1>
	<p class="muted">UPI payment confirmation for your shop.</p>
	<form method="POST" class="card" use:enhance={() => { busy = true; return async ({ update }) => { await update({ reset: false }); busy = false; }; }}>
		{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
		<label><span>Email</span><input name="email" type="email" autocomplete="username" required defaultValue={form?.email ?? ''} /></label>
		<label><span>Password</span><input name="password" type="password" autocomplete="current-password" required /></label>
		<label>
			<span>6-digit code from your authenticator app {form?.needOtp ? '' : '(owners and admins)'}</span>
			<!-- svelte-ignore a11y_autofocus -->
			<input name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="7" autofocus={form?.needOtp} />
		</label>
		<button disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
	</form>
</div>

<style>
	.wrap { max-width: 24rem; margin: 3rem auto; }
	input { width: 100%; }
	button { width: 100%; margin-top: .5rem; }
</style>
