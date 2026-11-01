<script lang="ts">
	// "Alerts on this phone": push notifications when a counter phone goes offline or a payment needs a look.
	let { publicKey }: { publicKey: string } = $props();

	type State = 'loading' | 'unsupported' | 'blocked' | 'off' | 'on';
	let mode = $state<State>('loading');
	let busy = $state(false);
	let note = $state('');

	const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
	const keyBytes = (b64: string) => {
		const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
		return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
	};
	const post = async (payload: unknown) => {
		const r = await fetch('/alerts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
		const j = await r.json().catch(() => ({}));
		if (!r.ok) throw new Error(j.error ?? j.message ?? `failed (${r.status})`);
		return j;
	};
	const label = () => {
		const ua = navigator.userAgent;
		const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
		const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : 'computer';
		return `${browser} on ${os}`;
	};

	$effect(() => {
		if (!supported()) return void (mode = 'unsupported');
		if (Notification.permission === 'denied') return void (mode = 'blocked');
		navigator.serviceWorker.ready
			.then((reg) => reg.pushManager.getSubscription())
			.then((sub) => (mode = sub ? 'on' : 'off'))
			.catch(() => (mode = 'off'));
	});

	async function turnOn() {
		busy = true;
		note = '';
		try {
			if ((await Notification.requestPermission()) !== 'granted') {
				mode = 'blocked';
				return;
			}
			const reg = await navigator.serviceWorker.ready;
			const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
			const j = sub.toJSON();
			await post({ action: 'subscribe', subscription: { endpoint: j.endpoint, keys: j.keys, label: label() } });
			mode = 'on';
			await test();
		} catch (e) {
			note = `Couldn't turn on alerts: ${e instanceof Error ? e.message : 'unknown error'}`;
		} finally {
			busy = false;
		}
	}

	async function turnOff() {
		busy = true;
		note = '';
		try {
			const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
			if (sub) {
				await post({ action: 'unsubscribe', endpoint: sub.endpoint });
				await sub.unsubscribe();
			}
			mode = 'off';
		} catch (e) {
			note = `Couldn't turn off alerts: ${e instanceof Error ? e.message : 'unknown error'}`;
		} finally {
			busy = false;
		}
	}

	async function test() {
		const r = await post({ action: 'test' });
		note = r.sent ? 'Test alert sent. It should appear in a few seconds.' : "The test alert didn't go through. Turn alerts off and on again.";
	}
</script>

<div class="card" data-testid="alerts-card">
	<strong>Alerts on this phone</strong>
	<p class="small muted">Get a notification when a counter phone goes offline or a payment needs a look. Turn it on for each phone or computer where you want alerts.</p>
	{#if mode === 'unsupported'}
		<p class="small">This browser can't show alerts. On an iPhone: tap Share → <strong>Add to Home Screen</strong>, open AutoConfirm from the home screen, and turn alerts on there.</p>
	{:else if mode === 'blocked'}
		<p class="small warn">Notifications are blocked for this site. Allow them in the browser's site settings (🔒 next to the address), then reload.</p>
	{:else if mode === 'on'}
		<p class="small">✓ Alerts are on for this device.</p>
		<div class="row">
			<button class="ghost small" disabled={busy} onclick={() => test().catch((e) => (note = e.message))}>Send test alert</button>
			<button class="ghost small" disabled={busy} onclick={turnOff}>Turn off</button>
		</div>
	{:else if mode === 'off'}
		<button disabled={busy} onclick={turnOn}>{busy ? 'Turning on…' : 'Turn on alerts on this phone'}</button>
	{/if}
	{#if note}<p class="small" role="status">{note}</p>{/if}
</div>
