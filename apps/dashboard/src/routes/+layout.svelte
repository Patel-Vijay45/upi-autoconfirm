<script lang="ts">
	import '$lib/styles.css';
	import { page } from '$app/state';
	import { can } from '$lib/format.ts';

	let { data, children } = $props();
	const role = $derived(data.me?.user.role);
	const nav = $derived(
		data.me
			? [
					{ href: '/', label: 'Payments', show: true },
					{ href: '/inbox', label: 'Inbox', show: can.act(role) || can.manage(role) },
					{ href: '/locations', label: 'Counters & phones', show: true },
					{ href: '/reports', label: 'Reports', show: true },
					{ href: '/developers', label: 'Developers', show: can.develop(role) },
					{ href: '/settings', label: 'Settings', show: can.manage(role) },
				].filter((n) => n.show)
			: [],
	);
	const current = (href: string) => (href === '/' ? page.url.pathname === '/' || page.url.pathname.startsWith('/payments') : page.url.pathname.startsWith(href));
</script>

<svelte:head><title>AutoConfirm dashboard</title></svelte:head>

{#if data.me}
	<header>
		<div class="top">
			<strong class="brand">AutoConfirm</strong>
			<span class="grow muted small shop">{data.me.merchant.name}</span>
			<form method="POST" action="/mode">
				<input type="hidden" name="mode" value={data.mode === 'live' ? 'test' : 'live'} />
				<button class="small {data.mode === 'live' ? 'ghost' : ''}" title="Switch between live and test data">
					{data.mode === 'live' ? 'Live data' : 'Test data'}
				</button>
			</form>
			<form method="POST" action="/logout"><button class="small ghost">Log out</button></form>
		</div>
		<nav aria-label="Main">
			{#each nav as n}
				<a href={n.href} aria-current={current(n.href) ? 'page' : undefined}>{n.label}</a>
			{/each}
		</nav>
		{#if data.mode === 'test'}<div class="testbar">Test mode: you are seeing test payments and test phones only.</div>{/if}
	</header>
{/if}

<main>
	{@render children()}
</main>

<style>
	header { background: var(--card); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 10; }
	.top { display: flex; gap: .5rem; align-items: center; max-width: 64rem; margin: 0 auto; padding: .6rem 1rem 0; }
	.brand { color: var(--accent); }
	.shop { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	nav { display: flex; gap: .25rem; overflow-x: auto; max-width: 64rem; margin: 0 auto; padding: .4rem 1rem; scrollbar-width: none; }
	nav a { white-space: nowrap; padding: .4rem .75rem; border-radius: 999px; text-decoration: none; color: var(--fg); }
	nav a[aria-current='page'] { background: var(--accent-soft); color: var(--accent); font-weight: 700; }
	.testbar { background: var(--test); color: #fff; text-align: center; font-size: .85rem; padding: .25rem; }
</style>
