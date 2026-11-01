<script lang="ts">
	import { ago, can, STATUS_LABEL } from '$lib/format.ts';
	import { autoRefresh } from '$lib/auto-refresh.svelte.ts';
	import AlertsCard from '$lib/AlertsCard.svelte';
	let { data, form } = $props();
	// Phones pairing, going offline or unpairing themselves show up without a refresh.
	const live = autoRefresh(15_000);
	const manage = $derived(can.manage(data.me.user.role));
	const phones = (loc: string) => data.devices.filter((d: { location_id: string }) => d.location_id === loc);
	const confirm = (msg: string) => (e: SubmitEvent) => {
		if (!window.confirm(msg)) e.preventDefault();
	};
</script>

<svelte:head><title>Counters & phones · AutoConfirm</title></svelte:head>

<h1>Counters & phones</h1>
<p class="muted small">
	Each counter is one UPI ID, with one or more phones running the AutoConfirm app.
	{#if live.paused}Auto-update paused. <button class="ghost small" onclick={() => live.resume()}>Refresh</button>{/if}
</p>
{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
{#if form?.done}<p class="notice" role="status">{form.done}</p>{/if}

{#if data.push.enabled && data.push.public_key}<AlertsCard publicKey={data.push.public_key} />{/if}

{#each data.locations as loc (loc.id)}
	<div class="card">
		<div class="row spread">
			<div class="grow">
				<strong>{loc.name}</strong>
				{#if !loc.active}<span class="badge b-cancelled">Paused</span>{/if}
				<div class="small muted">{loc.upi_payee_name} · <span class="mono">{loc.upi_vpa}</span></div>
			</div>
			{#if manage}
				<a class="btn small" href="/locations/{loc.id}/pair">Add phone</a>
				<form method="POST" action="?/update">
					<input type="hidden" name="id" value={loc.id} /><input type="hidden" name="active" value={loc.active ? 'false' : 'true'} />
					<button class="ghost small">{loc.active ? 'Pause' : 'Resume'}</button>
				</form>
			{/if}
		</div>
		{#if phones(loc.id).length === 0}
			<p class="small muted">No phone yet. Payments can't be confirmed automatically until you add one.</p>
		{:else}
			<div class="list">
				{#each phones(loc.id) as d (d.id)}
					<div class="item row spread" data-testid="phone">
						<div class="grow">
							<strong>{d.label}</strong> <span class="badge b-{d.status}">{STATUS_LABEL[d.status] ?? 'Not connected yet'}</span>
							<div class="small muted">
								Last check-in {ago(d.last_heartbeat)} · last payment {ago(d.last_signal)}{d.app_version ? ` · app ${d.app_version}` : ''}
							</div>
							{#if d.status !== 'revoked' && d.status !== 'pending'}
								{#if !d.listener_enabled}<div class="small warn">Notification access is off on this phone.</div>{/if}
								{#if d.battery_optimized}<div class="small warn">Battery optimisation is on. Android may stop the app.</div>{/if}
							{/if}
						</div>
						{#if manage && d.status !== 'revoked'}
							<form method="POST" action="?/revoke" onsubmit={confirm(`Remove ${d.label}? It will stop confirming payments.`)}>
								<input type="hidden" name="id" value={d.id} /><button class="danger small">Remove</button>
							</form>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/each}

{#if manage}
	<details class="card" open={data.locations.length === 0}>
		<summary><strong>Add a counter</strong></summary>
		<form method="POST" action="?/create">
			<label><span>Name</span><input name="name" required maxlength="80" placeholder="Counter 1" /></label>
			<label><span>Your business UPI ID</span><input name="upi_vpa" required placeholder="yourshop@ybl" autocapitalize="off" /></label>
			<label><span>Name customers see in their UPI app</span><input name="upi_payee_name" required maxlength="60" /></label>
			<button>Add counter</button>
		</form>
	</details>
{/if}

<style>
	.warn { color: var(--warn); }
	summary { cursor: pointer; }
</style>
