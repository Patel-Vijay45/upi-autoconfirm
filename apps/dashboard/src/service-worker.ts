/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
// Shows push alerts (phone offline, payment needs a look). No caching: the dashboard always loads fresh.
const sw = self as unknown as ServiceWorkerGlobalScope;

sw.addEventListener('install', () => void sw.skipWaiting());
sw.addEventListener('activate', (e) => e.waitUntil(sw.clients.claim()));

sw.addEventListener('push', (e) => {
	let n: { title?: string; body?: string; url?: string; tag?: string } = {};
	try {
		n = e.data?.json() ?? {};
	} catch {
		n = {};
	}
	e.waitUntil(sw.registration.showNotification(n.title ?? 'AutoConfirm', { body: n.body ?? '', tag: n.tag, data: { url: n.url ?? '/' } }));
});

sw.addEventListener('notificationclick', (e) => {
	e.notification.close();
	const target = new URL(String(e.notification.data?.url ?? '/'), sw.location.origin);
	const url = target.origin === sw.location.origin ? target.href : sw.location.origin + '/'; // only our own pages
	e.waitUntil(
		sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
			const open = list[0] as WindowClient | undefined;
			if (open) {
				await open.navigate(url).catch(() => undefined);
				return open.focus();
			}
			return sw.clients.openWindow(url);
		}),
	);
});
