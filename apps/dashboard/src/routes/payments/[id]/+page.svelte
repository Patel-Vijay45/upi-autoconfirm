<script lang="ts">
	import { inr, when, STATUS_LABEL, can } from '$lib/format.ts';
	let { data, form } = $props();
	const pi = $derived(data.pi);
	const role = $derived(data.me.user.role);
	const open = $derived(pi.status === 'pending' || pi.status === 'expired');
	const undoable = $derived(pi.status === 'paid' && pi.paid_at && Date.now() - Date.parse(pi.paid_at) < 24 * 3600_000);
	const confirm = (msg: string) => (e: SubmitEvent) => {
		if (!window.confirm(msg)) e.preventDefault();
	};
</script>

<svelte:head><title>{inr(pi.unique_amount)} · AutoConfirm</title></svelte:head>

<p><a href="/">← Payments</a></p>
<div class="card">
	<div class="row spread">
		<div>
			<div class="amount big">{inr(pi.unique_amount)}</div>
			<div class="muted small">Order total {inr(pi.amount)} + {pi.unique_amount - pi.amount} paise to identify the payment</div>
		</div>
		<span class="badge b-{pi.status}">{STATUS_LABEL[pi.status]}</span>
	</div>
	{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
	{#if form?.done}<p class="notice" role="status">{form.done}</p>{/if}
	<table>
		<tbody>
			<tr><th>Order</th><td>{pi.order_id ?? '—'}</td></tr>
			{#if pi.description}<tr><th>Description</th><td>{pi.description}</td></tr>{/if}
			{#if pi.customer}<tr><th>Customer</th><td>{pi.customer.name ?? ''} {pi.customer.phone ?? ''}</td></tr>{/if}
			<tr><th>Created</th><td>{when(pi.created)}</td></tr>
			<tr><th>Expires</th><td>{when(pi.expires_at)}</td></tr>
			{#if pi.paid_at}<tr><th>Paid</th><td>{when(pi.paid_at)}</td></tr>{/if}
			{#if pi.match}
				<tr>
					<th>How</th>
					<td>
						{pi.match.source === 'auto' ? 'Confirmed automatically by the phone' : 'Marked paid by staff'}
						{#if pi.match.app}· {pi.match.app}{/if}
						{#if pi.match.late}<span class="badge b-pending">late</span>{/if}
						{#if pi.match.amount_mismatch}<span class="badge b-pending">received {inr(pi.match.received_amount)}</span>{/if}
					</td>
				</tr>
			{/if}
			{#if pi.customer_claimed_at && pi.status !== 'paid'}<tr><th>Customer</th><td class="warn">Says they paid ({when(pi.customer_claimed_at)}). Check the phone or soundbox.</td></tr>{/if}
			<tr><th>Payment page</th><td><a href={pi.checkout_url} target="_blank" rel="noopener">Open checkout page</a></td></tr>
			<tr><th>ID</th><td class="mono">{pi.id}</td></tr>
		</tbody>
	</table>
</div>

{#if can.act(role) && open}
	<div class="card">
		<h2>Staff actions</h2>
		<form method="POST" action="?/markPaid" class="row" onsubmit={confirm(`Mark ${inr(pi.unique_amount)} as paid? Only do this after checking the money arrived on the phone or soundbox.`)}>
			<input name="note" placeholder="Note (e.g. checked on soundbox)" maxlength="200" class="grow" />
			<button>Mark paid</button>
		</form>
		<form method="POST" action="?/cancel" onsubmit={confirm('Cancel this payment request?')} style="margin-top:.75rem">
			<button class="danger small">Cancel payment request</button>
		</form>
	</div>
{/if}

{#if can.act(role) && undoable}
	<div class="card">
		<h2>Undo paid</h2>
		<p class="small muted">Only if this was a mistake. Allowed for 24 hours. The phone's payment goes back to the inbox.</p>
		<form method="POST" action="?/unmark" class="row" onsubmit={confirm('Undo the paid status?')}>
			<input name="reason" required maxlength="200" placeholder="Reason" class="grow" />
			<select name="status" aria-label="Then"><option value="pending">Reopen</option><option value="cancelled">Cancel</option></select>
			<button class="danger">Undo</button>
		</form>
	</div>
{/if}

<style>
	th { width: 9rem; }
	.warn { color: var(--warn); }
</style>
