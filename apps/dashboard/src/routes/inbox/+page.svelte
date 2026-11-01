<script lang="ts">
	import { enhance } from '$app/forms';
	import { inr, when, STATUS_LABEL } from '$lib/format.ts';
	let { data, form } = $props();
</script>

<svelte:head><title>Inbox · AutoConfirm</title></svelte:head>

<h1>Inbox</h1>
<nav class="tabs" aria-label="Inbox">
	<a href="/inbox" aria-current={data.tab === 'check' ? 'page' : undefined} data-testid="tab-check">Needs a look ({data.checkCount})</a>
	<a href="/inbox?tab=other" aria-current={data.tab === 'other' ? 'page' : undefined} data-testid="tab-other">Other payments ({data.otherCount}{data.otherMore ? '+' : ''})</a>
</nav>
{#if data.tab === 'check'}
	<p class="muted small">Money the phone saw that looks related to an order but wasn't matched automatically (for example the customer paid ₹930 instead of ₹930.07). Match it to the right order, or ignore it.</p>
{:else}
	<p class="muted small">Payments to your UPI ID that aren't near any recent order, usually walk-in customers paying directly. Nothing to do; they're listed here and in Reports. If one belongs to an order, tap Match.</p>
{/if}
{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
{#if form?.done}<p class="notice" role="status">{form.done}</p>{/if}

{#if data.signals.length === 0}
	<div class="card muted">{data.tab === 'check' ? 'Nothing to check. ✓' : 'No other payments.'}</div>
{/if}

{#each data.signals as s (s.id)}
	<div class="card" data-testid="signal">
		<div class="row spread">
			<div>
				<div class="amount big">{inr(s.amount)}</div>
				<div class="small muted">{s.payer_name ?? 'Unknown payer'} · {s.app} · {when(s.received_at)}{s.reference ? ` · Ref ${s.reference}` : ''}</div>
			</div>
			<span class="badge b-{s.status}">{s.likely_walk_in ? 'Walk-in' : STATUS_LABEL[s.status]}</span>
		</div>

		{#if s.status === 'review'}
			<p class="small">This matches an order above your auto-confirm limit. Check the phone or soundbox, then confirm.</p>
			<div class="row">
				<form method="POST" action="?/assign" use:enhance>
					<input type="hidden" name="signal" value={s.id} /><input type="hidden" name="intent" value={s.payment_intent} />
					<button>Confirm payment</button>
				</form>
				<form method="POST" action="?/reject" use:enhance>
					<input type="hidden" name="signal" value={s.id} />
					<button class="danger">Not this order</button>
				</form>
			</div>
		{:else if s.suggestions}
			{#if s.suggestions.length}
				<p class="small muted">Possible orders:</p>
				<div class="list">
					{#each s.suggestions as o}
						<form method="POST" action="?/assign" class="item row spread" use:enhance>
							<input type="hidden" name="signal" value={s.id} /><input type="hidden" name="intent" value={o.id} />
							<span class="grow">
								<strong>{o.order_id ?? o.id}</strong> · {inr(o.unique_amount)}
								{#if o.unique_amount !== s.amount}<span class="badge b-pending">differs by {inr(Math.abs(o.unique_amount - s.amount))}</span>{/if}
								<span class="small muted">· {when(o.created)} · {STATUS_LABEL[o.status]}</span>
							</span>
							<button class="small">Match</button>
						</form>
					{/each}
				</div>
			{:else}
				<p class="small muted">No open orders near this amount.</p>
			{/if}
			{#if data.tab === 'check'}
				<form method="POST" action="?/ignore" class="row" style="margin-top:.75rem" use:enhance>
					<input type="hidden" name="signal" value={s.id} />
					<input name="reason" placeholder="Reason (e.g. walk-in customer)" maxlength="200" class="grow" />
					<button class="ghost small">Ignore</button>
				</form>
			{/if}
		{:else}
			<a class="btn ghost small" href="/inbox?tab=other&open={encodeURIComponent(s.id)}">Match to an order…</a>
		{/if}
	</div>
{/each}
