// Browser behaviour shared by the hosted page and the widget: live status, countdown, "I have paid".
import { fill, STRINGS, type Lang } from './i18n.ts';
import { statusMessage } from './template.ts';
import type { CheckoutView, StatusUpdate } from './view.ts';

export interface MountConfig {
	lang: Lang;
	statusUrl: string;
	liveUrl: string | null;
	claimUrl: string;
	headers?: Record<string, string>;
	/** Hosted page: go to return_url after paid. The widget leaves that to the merchant. */
	redirectOnPaid: boolean;
	onPaid?: (v: CheckoutView) => void;
	onExpired?: () => void;
}

const STILL_CHECKING_MS = 2 * 60_000;
const LATE_WINDOW_MS = 30 * 60_000; // late payments can still be confirmed (grace window)

export function mount(root: HTMLElement, view: CheckoutView, cfg: MountConfig): () => void {
	const t = STRINGS[cfg.lang];
	const msg = root.querySelector<HTMLElement>('[data-ac-msg]')!;
	const timer = root.querySelector<HTMLElement>('[data-ac-timer]')!;
	const claim = root.querySelector<HTMLButtonElement>('[data-ac-claim]');
	let status = view.status;
	let claimedAt = 0;
	let ws: WebSocket | null = null;
	let wsTries = 0;
	let stopped = false;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let expiredFired = false;
	const expiresAt = Date.parse(view.expires_at);

	const sub = root.querySelector<HTMLElement>('[data-ac-sub]');
	const render = () => {
		root.dataset.status = status;
		let text = statusMessage({ status }, cfg.lang);
		if (sub) sub.textContent = status === 'paid' && cfg.redirectOnPaid && view.return_url ? t.redirecting : '';
		if (status === 'pending' && claimedAt) text = Date.now() - claimedAt > STILL_CHECKING_MS ? t.stillChecking : t.checking;
		if (msg.textContent !== text) msg.textContent = text;
		if (status === 'pending') {
			const left = Math.max(0, expiresAt - Date.now());
			const m = Math.floor(left / 60_000);
			const s = Math.floor((left % 60_000) / 1000);
			timer.textContent = fill(t.expiresIn, { time: `${m}:${String(s).padStart(2, '0')}` });
		}
	};

	const apply = (u: StatusUpdate) => {
		if (stopped || !u || !u.status) return;
		const prev = status;
		status = u.status;
		view = { ...view, status: u.status, paid_at: u.paid_at ?? view.paid_at };
		render();
		if (status === 'paid' && prev !== 'paid') {
			paid();
		} else if (status === 'cancelled') {
			cleanup(false);
		} else if (status === 'expired' && !expiredFired) {
			expiredFired = true;
			cfg.onExpired?.();
		}
	};

	const paid = () => {
		cleanup(false);
		cfg.onPaid?.(view);
		if (cfg.redirectOnPaid && view.return_url && /^https?:\/\//.test(view.return_url)) {
			setTimeout(() => location.assign(view.return_url!), 1500);
		}
	};

	const check = async () => {
		if (stopped) return;
		try {
			const r = await fetch(cfg.statusUrl, { headers: cfg.headers ?? {}, cache: 'no-store' });
			if (r.ok) apply((await r.json()) as StatusUpdate);
		} catch {
			/* offline: try again on the next tick */
		}
	};

	const schedulePoll = () => {
		clearTimeout(pollTimer);
		if (stopped) return;
		const live = ws !== null && ws.readyState === 1;
		const inLateWindow = status === 'expired' && Date.now() < expiresAt + LATE_WINDOW_MS;
		if (status !== 'pending' && !inLateWindow) return;
		pollTimer = setTimeout(
			async () => {
				await check();
				schedulePoll();
			},
			status === 'expired' || live ? 15_000 : 3_000,
		);
	};

	const connect = () => {
		if (!cfg.liveUrl || stopped || typeof WebSocket === 'undefined' || wsTries >= 3) return;
		wsTries++;
		try {
			ws = new WebSocket(cfg.liveUrl);
		} catch {
			ws = null;
			return;
		}
		ws.onopen = () => {
			wsTries = 0;
			schedulePoll();
		};
		ws.onmessage = (e) => {
			try {
				const data = JSON.parse(String(e.data)) as StatusUpdate & { type?: string };
				if (data.type === 'status') apply(data);
			} catch {
				/* ignore */
			}
		};
		ws.onclose = () => {
			ws = null;
			if (!stopped) setTimeout(connect, 2000 * wsTries);
			schedulePoll();
		};
	};

	const onClaim = () => {
		if (!claimedAt) {
			claimedAt = Date.now();
			fetch(cfg.claimUrl, { method: 'POST', headers: cfg.headers ?? {} })
				.then((r) => r.json())
				.then((j: { phone_offline?: boolean }) => {
					// The shop's phone is offline: say "show this screen at the counter" now, not after 2 min.
					if (j.phone_offline) (claimedAt -= STILL_CHECKING_MS + 1), render();
				})
				.catch(() => undefined);
		}
		render();
		void check();
	};

	// Customers come back from the UPI app: re-check at once.
	const onVisible = () => {
		if (document.visibilityState === 'visible') void check();
	};
	const onShow = () => void check();

	const tick = setInterval(() => {
		render();
		if (status === 'pending' && Date.now() >= expiresAt) void check();
	}, 1000);

	function cleanup(detachUi: boolean) {
		stopped = true;
		clearInterval(tick);
		clearTimeout(pollTimer);
		if (ws) {
			ws.onclose = null;
			ws.close();
			ws = null;
		}
		removeEventListener('pageshow', onShow);
		document.removeEventListener('visibilitychange', onVisible);
		if (detachUi) claim?.removeEventListener('click', onClaim);
		if (status !== 'pending') timer.textContent = '';
	}

	claim?.addEventListener('click', onClaim);
	addEventListener('pageshow', onShow);
	document.addEventListener('visibilitychange', onVisible);
	render();
	if (status === 'pending' || status === 'expired') {
		connect();
		schedulePoll();
	}
	if (status === 'paid') paid();
	return () => cleanup(true);
}
