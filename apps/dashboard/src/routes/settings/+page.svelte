<script lang="ts">
	import { ago, inr, when } from '$lib/format.ts';
	let { data, form } = $props();
	const s = $derived(data.settings);
	const rupees = (p: number | null) => (p === null ? '' : inr(p).replace('₹', '').replace(/,/g, ''));
	const confirm = (msg: string) => (e: SubmitEvent) => {
		if (!window.confirm(msg)) e.preventDefault();
	};
</script>

<svelte:head><title>Settings · AutoConfirm</title></svelte:head>

<h1>Settings</h1>
{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
{#if form?.done}<p class="notice" role="status">{form.done}</p>{/if}

<h2>Payments</h2>
<form method="POST" action="?/save" class="card">
	<label>
		<span>Auto-confirm limit (₹). Payments above this wait for one staff tap in the inbox. Empty = no limit.</span>
		<input name="auto_confirm_max" inputmode="decimal" defaultValue={rupees(s.auto_confirm_max)} placeholder="No limit" />
	</label>
	<label><span>Payment request expires after (minutes)</span><input name="intent_ttl" type="number" min="2" max="180" defaultValue={s.intent_ttl / 60} /></label>
	<label><span>Longest expiry your website may ask for (minutes, up to 180)</span><input name="max_intent_ttl" type="number" min="2" max="180" defaultValue={s.max_intent_ttl / 60} /></label>
	<p class="small muted">Late payments are still matched for {s.grace_window / 60} min after expiry. An amount is reused only {s.reuse_cooldown / 60} min after its order closes.</p>
	<button>Save</button>
</form>

<h2>Team</h2>
<div class="card">
	{#if form?.inviteUrl}
		<div class="secret" role="status">
			Send this one-time setup link to <strong>{form.inviteEmail}</strong> (valid 72 hours):
			<p class="mono" data-testid="invite-url">{form.inviteUrl}</p>
		</div>
	{/if}
	<div class="list">
		{#each data.users as u (u.id)}
			<div class="item row spread">
				<div class="grow">
					<strong>{u.email}</strong> <span class="badge">{u.role}</span>
					{#if !u.active}<span class="badge b-revoked">{u.invited ? 'Invited' : 'Deactivated'}</span>{/if}
					<div class="small muted">{u.mfa ? 'Authenticator on' : 'No authenticator'} · last login {ago(u.last_login)}</div>
				</div>
				{#if u.active && u.id !== data.me.user.id}
					<form method="POST" action="?/deactivate" onsubmit={confirm(`Deactivate ${u.email}?`)}>
						<input type="hidden" name="id" value={u.id} /><button class="danger small">Deactivate</button>
					</form>
				{/if}
			</div>
		{/each}
	</div>
	<form method="POST" action="?/invite" class="row" style="margin-top:.75rem">
		<input name="email" type="email" required placeholder="name@example.com" class="grow" />
		<select name="role" aria-label="Role">
			<option value="staff">Staff (payments and inbox)</option>
			<option value="developer">Developer (keys and webhooks)</option>
			<option value="admin">Admin (everything)</option>
			{#if data.me.user.role === 'owner'}<option value="owner">Owner</option>{/if}
		</select>
		<button class="small">Invite</button>
	</form>
</div>

<h2>Activity log</h2>
<div class="card table-wrap">
	<table>
		<thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
		<tbody>
			{#each data.audit as a (a.id)}
				<tr><td>{when(a.at)}</td><td class="small">{a.actor}</td><td>{a.action} <span class="mono small muted">{a.object_id ?? ''}</span></td></tr>
			{:else}
				<tr><td colspan="3" class="muted small">Nothing yet.</td></tr>
			{/each}
		</tbody>
	</table>
</div>
