<script lang="ts">
	import { ago, when } from '$lib/format.ts';
	let { data, form } = $props();
	const EVENTS = ['payment_intent.paid', 'payment_intent.expired', 'payment_intent.cancelled', 'payment_intent.unpaid', 'signal.unmatched', 'signal.review_required'];
	const confirm = (msg: string) => (e: SubmitEvent) => {
		if (!window.confirm(msg)) e.preventDefault();
	};
</script>

<svelte:head><title>Developers · AutoConfirm</title></svelte:head>

<h1>Developers</h1>
{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
{#if form?.done}<p class="notice" role="status">{form.done}</p>{/if}
{#if form?.newKey}
	<div class="secret" role="status"><strong>Copy this key now. It won't be shown again.</strong><p class="mono" data-testid="new-key">{form.newKey}</p></div>
{/if}
{#if form?.newSecret}
	<div class="secret" role="status"><strong>Webhook signing secret. Copy it now; it won't be shown again.</strong><p class="mono" data-testid="new-secret">{form.newSecret}</p></div>
{/if}

<h2>API keys ({data.mode})</h2>
<div class="card">
	<p class="small muted">Secret keys (<span class="mono">sk_</span>) are for your server only. Publishable keys (<span class="mono">pk_</span>) are safe in the browser for checkout.js.</p>
	<div class="table-wrap">
		<table>
			<thead><tr><th>Key</th><th>Type</th><th>Created</th><th>Last used</th><th></th></tr></thead>
			<tbody>
				{#each data.keys as k (k.id)}
					<tr>
						<td class="mono">{k.prefix}…</td>
						<td>{k.kind}</td>
						<td>{when(k.created)}</td>
						<td>{ago(k.last_used)}</td>
						<td>
							{#if k.revoked}<span class="badge b-revoked">Revoked</span>{:else}
								<form method="POST" action="?/revokeKey" onsubmit={confirm('Revoke this key? Anything using it stops working.')}>
									<input type="hidden" name="id" value={k.id} /><button class="danger small">Revoke</button>
								</form>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<form method="POST" action="?/createKey" class="row" style="margin-top:.75rem">
		<select name="kind" aria-label="Key type"><option value="secret">Secret key</option><option value="publishable">Publishable key</option></select>
		<button class="small">Create key</button>
	</form>
</div>

<h2>Webhooks</h2>
<div class="card">
	{#each data.endpoints as ep (ep.id)}
		<div class="row spread item">
			<div class="grow"><span class="mono">{ep.url}</span><div class="small muted">{ep.events.join(', ')}</div></div>
			<span class="badge {ep.enabled ? 'b-online' : 'b-revoked'}">{ep.enabled ? 'On' : 'Off'}</span>
			<form method="POST" action="?/toggle">
				<input type="hidden" name="id" value={ep.id} /><input type="hidden" name="enable" value={ep.enabled ? 'false' : 'true'} />
				<button class="ghost small">{ep.enabled ? 'Turn off' : 'Turn on'}</button>
			</form>
		</div>
	{:else}
		<p class="small muted">No webhook endpoints yet.</p>
	{/each}
	<details style="margin-top:.75rem">
		<summary>Add endpoint</summary>
		<form method="POST" action="?/addEndpoint">
			<label><span>HTTPS URL</span><input name="url" type="url" required placeholder="https://yoursite.com/webhooks/autoconfirm" style="width:100%" /></label>
			<fieldset>
				<legend class="small muted">Events (none ticked = all)</legend>
				{#each EVENTS as e}<label class="small"><input type="checkbox" name="events" value={e} /> {e}</label>{/each}
			</fieldset>
			<button class="small">Add endpoint</button>
		</form>
	</details>
</div>

<h2>Recent deliveries</h2>
<div class="card table-wrap">
	<table>
		<thead><tr><th>When</th><th>Event</th><th>Attempt</th><th>Result</th></tr></thead>
		<tbody>
			{#each data.deliveries as d (d.id)}
				<tr><td>{when(d.created)}</td><td>{d.type}</td><td>{d.attempt}</td><td><span class="badge {d.status === 'succeeded' ? 'b-online' : d.status === 'failed' ? 'b-revoked' : 'b-pending'}">{d.status}</span> {d.http_status ?? d.error ?? ''}</td></tr>
			{:else}
				<tr><td colspan="4" class="muted small">No deliveries yet.</td></tr>
			{/each}
		</tbody>
	</table>
</div>

<h2>Recent events</h2>
<div class="card table-wrap">
	<table>
		<thead><tr><th>When</th><th>Type</th><th>Object</th><th></th></tr></thead>
		<tbody>
			{#each data.events as e (e.id)}
				<tr>
					<td>{when(e.created)}</td><td>{e.type}</td><td class="mono">{e.object_id}</td>
					<td><form method="POST" action="?/resend"><input type="hidden" name="id" value={e.id} /><button class="ghost small">Resend</button></form></td>
				</tr>
			{:else}
				<tr><td colspan="4" class="muted small">No events yet.</td></tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	fieldset { border: 0; padding: 0; margin: .5rem 0; }
	fieldset label { display: block; margin: .2rem 0; }
	summary { cursor: pointer; }
</style>
