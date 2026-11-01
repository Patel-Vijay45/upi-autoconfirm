import { invalidateAll } from '$app/navigation';

/**
 * Re-runs the page's data loading every `everyMs` while the tab is on screen and `when()` is true.
 * Pauses after `forMs` (10 min) so a forgotten tab doesn't use up the free plan's daily requests;
 * `resume()` starts it again. Call it from a component's <script>.
 */
export function autoRefresh(everyMs: number, when: () => boolean = () => true, forMs = 10 * 60_000) {
	let until = Date.now() + forMs;
	const s = $state({ paused: false });
	$effect(() => {
		if (!when() || s.paused) return;
		const t = setInterval(() => {
			if (Date.now() > until) s.paused = true;
			else if (document.visibilityState === 'visible') void invalidateAll();
		}, everyMs);
		return () => clearInterval(t);
	});
	return {
		get paused() {
			return s.paused;
		},
		resume() {
			until = Date.now() + forMs;
			s.paused = false;
			void invalidateAll();
		},
	};
}
