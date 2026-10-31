// checkout.js: drop-in widget. Usage (docs/API.md §7):
//   AutoConfirm.open({ key: 'pk_live_…', intent: 'pi_…', lang: 'en', onPaid, onExpired, onClose })
// Renders in a shadow root (bottom sheet on phones, dialog on desktop). Your server must still confirm
// the payment with the webhook or GET /v1/payment_intents/:id before fulfilling.
import { mount } from './client.ts';
import { pickLang, STRINGS, type Lang } from './i18n.ts';
import { CHECKOUT_CSS, renderCheckout } from './template.ts';
import type { CheckoutView } from './view.ts';

interface OpenOptions {
	key: string;
	intent: string;
	lang?: Lang;
	onPaid?: (pi: { id: string; status: string; order_id: string | null; paid_at: string | null }) => void;
	onExpired?: () => void;
	onClose?: () => void;
}

const script = document.currentScript as HTMLScriptElement | null;
const BASE = script?.src ? new URL(script.src).origin : location.origin;

const SHEET_CSS = `
:host{all:initial}
.ov{position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center}
.sh{position:relative;width:100%;max-width:28rem;max-height:92vh;overflow:auto;background:#fff;border-radius:18px 18px 0 0;padding-top:.5rem}
.x{position:absolute;top:.4rem;right:.5rem;border:0;background:transparent;font:700 1.5rem/1 system-ui,sans-serif;color:#555;cursor:pointer;padding:.5rem;z-index:1}
.sh .ac-head{padding-right:2.25rem}
.ld{padding:3rem 1rem;text-align:center;font:16px system-ui,sans-serif;color:#555}
@media (min-width:40rem){.ov{align-items:center}.sh{border-radius:18px}}
@media (prefers-color-scheme:dark){.sh{background:#121212}.x,.ld{color:#bbb}}
`;

function open(opts: OpenOptions): { close: () => void } {
	if (!opts || !/^pk_(live|test)_/.test(opts.key) || !/^pi_[a-z0-9]{10,}$/.test(opts.intent)) {
		throw new Error('AutoConfirm.open needs { key: "pk_…", intent: "pi_…" }');
	}
	const lang = opts.lang && opts.lang in STRINGS ? opts.lang : pickLang(navigator.language);
	const auth = { authorization: `Bearer ${opts.key}` };
	const api = `${BASE}/v1/public/payment_intents/${encodeURIComponent(opts.intent)}`;

	const host = document.createElement('div');
	const shadow = host.attachShadow({ mode: 'open' });
	const style = document.createElement('style');
	style.textContent = SHEET_CSS + CHECKOUT_CSS;
	const ov = document.createElement('div');
	ov.className = 'ov';
	ov.innerHTML = `<div class="sh" role="dialog" aria-modal="true"><button class="x" type="button" aria-label="${STRINGS[lang].close}">×</button><div class="bd"><div class="ld">…</div></div></div>`;
	shadow.append(style, ov);
	document.body.appendChild(host);

	let unmount: (() => void) | null = null;
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		unmount?.();
		host.remove();
		removeEventListener('keydown', onKey);
		opts.onClose?.();
	};
	const onKey = (e: KeyboardEvent) => {
		if (e.key === 'Escape') close();
	};
	addEventListener('keydown', onKey);
	ov.querySelector('.x')!.addEventListener('click', close);
	ov.addEventListener('click', (e) => {
		if (e.target === ov) close();
	});

	fetch(api, { headers: auth, cache: 'no-store' })
		.then((r) => (r.ok ? (r.json() as Promise<CheckoutView>) : Promise.reject(new Error(`HTTP ${r.status}`))))
		.then((view) => {
			if (closed) return;
			const body = ov.querySelector<HTMLElement>('.bd')!;
			body.innerHTML = renderCheckout(view, lang);
			const wsBase = BASE.replace(/^http/, 'ws');
			unmount = mount(body.querySelector<HTMLElement>('[data-ac-root]')!, view, {
				lang,
				statusUrl: `${api}/status`,
				liveUrl: `${wsBase}/v1/public/payment_intents/${encodeURIComponent(opts.intent)}/live?key=${encodeURIComponent(opts.key)}`,
				claimUrl: `${api}/claim`,
				headers: auth,
				redirectOnPaid: false,
				onPaid: (v) => opts.onPaid?.({ id: v.id, status: v.status, order_id: v.order_id, paid_at: v.paid_at }),
				onExpired: opts.onExpired,
			});
		})
		.catch(() => {
			const ld = ov.querySelector('.ld');
			if (ld) ld.textContent = '⚠';
		});

	return { close };
}

(window as unknown as { AutoConfirm: { open: typeof open; version: string } }).AutoConfirm = { open, version: '1' };
