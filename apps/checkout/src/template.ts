// One markup source for the hosted checkout page (rendered on the server) and the checkout.js widget.
import { fill, STRINGS, type Lang } from './i18n.ts';
import type { CheckoutView } from './view.ts';

export function esc(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Only real UPI app links are ever put in an href. */
function upiHref(url: string): string {
	return /^(upi|gpay|phonepe|paytmmp):\/\//.test(url) ? esc(url) : '#';
}

export function statusMessage(view: Pick<CheckoutView, 'status'>, lang: Lang): string {
	const t = STRINGS[lang];
	if (view.status === 'paid') return t.paid;
	if (view.status === 'expired') return t.expired;
	if (view.status === 'cancelled') return t.cancelled;
	return '';
}

export function renderCheckout(view: CheckoutView, lang: Lang): string {
	const t = STRINGS[lang];
	const extra = view.unique_amount - view.amount;
	return (
		`<div class="ac" data-ac-root data-status="${esc(view.status)}" lang="${lang}">` +
		`<div class="ac-head"><div class="ac-payee">${esc(fill(t.payTo, { payee: view.payee_name }))}</div>` +
		(view.order_id ? `<div class="ac-order">${esc(view.order_id)}</div>` : '') +
		`</div>` +
		`<div class="ac-box"><div class="ac-label">${esc(t.payExactly)}</div>` +
		`<div class="ac-amount">₹${esc(view.display_amount)}</div>` +
		(extra > 0 ? `<div class="ac-note">${esc(fill(t.extraNote, { paise: extra }))}</div>` : '') +
		`</div>` +
		`<div class="ac-pay">` +
		`<div class="ac-apps">` +
		`<a class="ac-btn ac-main" href="${upiHref(view.upi.apps.gpay)}">${esc(t.gpay)}</a>` +
		`<a class="ac-btn ac-main" href="${upiHref(view.upi.apps.phonepe)}">${esc(t.phonepe)}</a>` +
		`<a class="ac-btn ac-main" href="${upiHref(view.upi.apps.paytm)}">${esc(t.paytm)}</a>` +
		`<a class="ac-btn ac-alt" href="${upiHref(view.upi.uri)}">${esc(t.otherApp)}</a>` +
		`</div>` +
		`<div class="ac-qr">${view.qr_svg}<div class="ac-hint">${esc(t.qrHint)}</div></div>` +
		`<button class="ac-btn ac-alt" type="button" data-ac-claim>${esc(t.iHavePaid)}</button>` +
		`<div class="ac-timer" data-ac-timer></div>` +
		`</div>` +
		`<div class="ac-msg" data-ac-msg role="status" aria-live="polite">${esc(statusMessage(view, lang))}</div>` +
		`<div class="ac-sub" data-ac-sub></div>` +
		`</div>`
	);
}

/** Scoped styles (work on the page and inside the widget's shadow root). */
export const CHECKOUT_CSS = `
.ac{--fg:#111;--muted:#555;--bg:#fff;--card:#f4f5f7;--accent:#0b6b3a;--accent-fg:#fff;--line:#d9dce1;--warn:#8a4b00;
font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Noto Sans Devanagari","Noto Sans Gujarati",sans-serif;
color:var(--fg);background:var(--bg);max-width:26rem;margin:0 auto;padding:1rem;box-sizing:border-box}
.ac *{box-sizing:border-box}
@media (prefers-color-scheme:dark){.ac{--fg:#f2f2f2;--muted:#b9b9b9;--bg:#121212;--card:#1e1e1e;--accent:#2fa866;--accent-fg:#06140c;--line:#333;--warn:#f0b35a}}
.ac-head{display:flex;justify-content:space-between;align-items:baseline;gap:.5rem;margin-bottom:.75rem}
.ac-payee{font-weight:700;font-size:1.05rem;overflow-wrap:anywhere}
.ac-order{color:var(--muted);font-size:.85rem;white-space:nowrap}
.ac-box{background:var(--card);border-radius:14px;padding:1rem;text-align:center;margin-bottom:1rem}
.ac-label{color:var(--muted);font-size:.9rem}
.ac-amount{font-size:2.6rem;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.ac-note{color:var(--muted);font-size:.85rem}
.ac-pay{display:flex;flex-direction:column;gap:.75rem}
.ac-apps{display:flex;flex-direction:column;gap:.6rem}
.ac-btn{display:block;width:100%;padding:.95rem 1rem;border-radius:999px;font:inherit;font-weight:700;text-align:center;text-decoration:none;cursor:pointer;border:2px solid var(--accent)}
.ac-main{background:var(--accent);color:var(--accent-fg)}
.ac-alt{background:transparent;color:var(--accent)}
.ac-btn:focus-visible{outline:3px solid var(--fg);outline-offset:2px}
.ac-qr{text-align:center}
.ac-qr svg{width:13rem;height:13rem;max-width:100%;border-radius:8px;border:1px solid var(--line)}
.ac-hint{color:var(--muted);font-size:.85rem;margin-top:.25rem}
.ac-timer{text-align:center;color:var(--muted);font-size:.9rem;font-variant-numeric:tabular-nums;min-height:1.3em}
.ac-msg{margin-top:1rem;text-align:center;font-weight:700;min-height:1.4em}
.ac[data-status=paid] .ac-msg{color:var(--accent);font-size:1.4rem}
.ac-sub{text-align:center;color:var(--muted);font-size:.9rem;margin-top:.25rem}
.ac[data-status=expired] .ac-msg,.ac[data-status=cancelled] .ac-msg,.ac[data-late] .ac-msg{color:var(--warn)}
.ac:not([data-status=pending]) .ac-pay{display:none}
.ac[data-status=paid] .ac-box{outline:3px solid var(--accent)}
/* Desktop: QR first. Pay buttons are never hidden, in case a phone browser reports itself as a desktop. */
@media (hover:hover) and (pointer:fine){.ac-qr{order:-1}.ac-qr svg{width:15rem;height:15rem}}
`;
