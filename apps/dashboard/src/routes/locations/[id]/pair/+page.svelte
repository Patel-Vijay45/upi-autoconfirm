<script lang="ts">
	import { when } from '$lib/format.ts';
	let { data, form } = $props();
</script>

<svelte:head><title>Add phone · AutoConfirm</title></svelte:head>

<p><a href="/locations">← Counters & phones</a></p>
<h1>Add a phone to {data.loc.name}</h1>
<div class="card">
	<ol>
		<li>Install the AutoConfirm app on the counter phone (the phone with your payment app for <span class="mono">{data.loc.upi_vpa}</span>).</li>
		<li>Create a pairing code below and scan it with that phone's camera. The app opens and pairs itself.</li>
		<li>Finish the checklist in the app, then send ₹1 to your UPI ID from another phone to test.</li>
	</ol>
	{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
	{#if form?.link}
		<div class="qr" data-testid="pairing-qr">{@html form.qr}</div>
		<p class="small">Valid once, until {when(form.expires_at)}. On the phone you can also paste this link into the app:</p>
		<p class="mono small" data-testid="pairing-link">{form.link}</p>
		<form method="POST"><button class="ghost small">New code</button></form>
	{:else}
		<form method="POST"><button>Create pairing code</button></form>
	{/if}
</div>
{#if data.mode === 'test'}<p class="small muted">You're in test mode, so this pairs a test phone (for example the device simulator). It will never confirm live payments.</p>{/if}
