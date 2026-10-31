// Hosted checkout page script (/p/:id). Config is embedded by the server as JSON.
import { mount } from './client.ts';
import type { Lang } from './i18n.ts';
import type { CheckoutView } from './view.ts';

interface PageConfig {
	view: CheckoutView;
	lang: Lang;
	statusUrl: string;
	liveUrl: string;
	claimUrl: string;
}

const el = document.getElementById('ac-config');
const root = document.querySelector<HTMLElement>('[data-ac-root]');
if (el && root) {
	const cfg = JSON.parse(el.textContent || '{}') as PageConfig;
	mount(root, cfg.view, { lang: cfg.lang, statusUrl: cfg.statusUrl, liveUrl: cfg.liveUrl, claimUrl: cfg.claimUrl, redirectOnPaid: true });
}
