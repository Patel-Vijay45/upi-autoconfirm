<script lang="ts">
	import { inr } from '$lib/format.ts';
	let { data } = $props();
	const r = $derived(data.report);
</script>

<svelte:head><title>Reports · AutoConfirm</title></svelte:head>

<h1>Reports</h1>
<form method="GET" class="row card">
	<label><span>From</span><input type="date" name="from" defaultValue={r.from} /></label>
	<label><span>To</span><input type="date" name="to" defaultValue={r.to} /></label>
	<button class="small">Show</button>
	<a class="btn ghost small" href="/reports/payments.csv?from={r.from}&to={r.to}" download>Download CSV</a>
</form>

<div class="row">
	<div class="card grow"><div class="muted small">Received</div><div class="amount big" data-testid="total-received">{inr(r.total.received)}</div></div>
	<div class="card grow"><div class="muted small">Paid orders</div><div class="amount big">{r.total.paid_count}</div><div class="small muted">{r.total.auto_count} confirmed automatically</div></div>
	<div class="card grow"><div class="muted small">Still in inbox</div><div class="amount big">{r.total.open_inbox}</div></div>
	<div class="card grow" data-testid="walk-in-total"><div class="muted small">Other payments (walk-ins)</div><div class="amount big">{inr(r.total.walk_in_received)}</div><div class="small muted">{r.total.walk_in_count} payments</div></div>
</div>

<div class="card table-wrap">
	<table>
		<thead><tr><th>Day (IST)</th><th>Paid orders</th><th>Received</th><th>Auto</th><th>Late</th><th>Inbox</th><th>Walk-ins</th></tr></thead>
		<tbody>
			{#each r.days as d (d.day)}
				<tr><td>{d.day}</td><td>{d.paid_count}</td><td class="amount">{inr(d.received)}</td><td>{d.auto_count}</td><td>{d.late_count}</td><td>{d.open_inbox}</td><td class="amount">{d.walk_in_count ? inr(d.walk_in_received) : ''}</td></tr>
			{:else}
				<tr><td colspan="7" class="muted small">No payments in this period.</td></tr>
			{/each}
		</tbody>
	</table>
</div>
<p class="small muted">"Received" is what customers sent, including the identifying paise. Match it against your bank statement.</p>
