<script lang="ts">
	import { page } from '$app/state';
	import { inr, when, STATUS_LABEL } from '$lib/format.ts';
	let { data, form } = $props();
	let showNew = $state(false);
	const tabs = [['', 'All'], ['pending', 'Waiting'], ['paid', 'Paid'], ['expired', 'Expired'], ['cancelled', 'Cancelled']];
	const href = (status: string) => {
		const q = new URLSearchParams();
		if (status) q.set('status', status);
		if (data.location) q.set('location_id', data.location);
		return `/?${q}`;
	};
	const locName = (id: string) => data.locations.find((l: { id: string }) => l.id === id)?.name ?? id;
	const next = $derived.by(() => {
		const last = data.intents.data.at(-1);
		if (!data.intents.has_more || !last) return null;
		const q = new URLSearchParams(page.url.searchParams);
		q.set('starting_after', last.id);
		return `/?${q}`;
	});
</script>

<svelte:head><title>Payments · AutoConfirm</title></svelte:head>

<div class="row spread">
	<h1>Payments</h1>
	{#if data.locations.length > 1}
		<form method="GET" class="row">
			{#if data.status}<input type="hidden" name="status" value={data.status} />{/if}
			<select name="location_id" onchange={(e) => (e.currentTarget.form as HTMLFormElement).submit()} aria-label="Counter">
				<option value="">All counters</option>
				{#each data.locations as l}<option value={l.id} selected={l.id === data.location}>{l.name}</option>{/each}
			</select>
			<noscript><button class="small">Filter</button></noscript>
		</form>
	{/if}
</div>

<details class="card" open={showNew || !!form?.error} ontoggle={(e) => (showNew = (e.currentTarget as HTMLDetailsElement).open)}>
	<summary><strong>+ New payment</strong> <span class="small muted">(customer pays at the counter)</span></summary>
	<form method="POST" action="?/create" class="row" style="margin-top:.75rem">
		<input type="hidden" name="key" value={data.newKey} />
		<label class="grow"><span>Amount (₹)</span><input name="amount" inputmode="decimal" required placeholder="250" defaultValue={form?.amount ?? ''} /></label>
		<label class="grow"><span>Order or note (optional)</span><input name="note" maxlength="64" placeholder="Table 4" defaultValue={form?.note ?? ''} /></label>
		{#if data.locations.length > 1}
			<label><span>Counter</span><select name="location_id">{#each data.locations as l}<option value={l.id}>{l.name}</option>{/each}</select></label>
		{/if}
		<button>Create and show QR</button>
	</form>
	{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
</details>

<nav class="tabs" aria-label="Status">
	{#each tabs as [s, label]}<a href={href(s)} aria-current={data.status === s ? 'page' : undefined}>{label}</a>{/each}
</nav>

{#if data.intents.data.length === 0}
	<div class="card muted">No payments here yet. They appear when your website or POS creates one through the API.</div>
{:else}
	<div class="card list">
		{#each data.intents.data as pi}
			<a class="item row spread" href="/payments/{pi.id}">
				<div class="grow">
					<div class="amount">{inr(pi.unique_amount)}</div>
					<div class="small muted">{pi.order_id ?? pi.id} · {when(pi.created)}{data.locations.length > 1 ? ` · ${locName(pi.location_id)}` : ''}</div>
				</div>
				<span class="badge b-{pi.status}">{STATUS_LABEL[pi.status]}{pi.match?.source === 'manual' ? ' (manual)' : ''}</span>
			</a>
		{/each}
	</div>
	{#if next}<a class="btn ghost" href={next}>Older payments</a>{/if}
{/if}

<style>
	summary { cursor: pointer; }
	a.item { text-decoration: none; color: inherit; }
	a.item:hover .amount { color: var(--accent); }
</style>
