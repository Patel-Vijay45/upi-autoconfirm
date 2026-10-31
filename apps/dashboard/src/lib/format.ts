// Display helpers. Money is integer paise; formatting uses integer and string maths only.

/** 12345678 -> "₹1,23,456.78" (Indian digit grouping). */
export function inr(paise: number | null | undefined): string {
	if (paise === null || paise === undefined) return '—';
	const neg = paise < 0;
	const p = Math.abs(paise);
	const rupees = Math.floor(p / 100).toString();
	const frac = (p % 100).toString().padStart(2, '0');
	const last3 = rupees.slice(-3);
	const rest = rupees.slice(0, -3);
	const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
	return `${neg ? '-' : ''}₹${grouped}.${frac}`;
}

const dt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function when(iso: string | null | undefined): string {
	return iso ? dt.format(new Date(iso)) : '—';
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
	if (!iso) return 'never';
	const s = Math.round((now - Date.parse(iso)) / 1000);
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)} min ago`;
	if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
	return `${Math.floor(s / 86400)} d ago`;
}

export const STATUS_LABEL: Record<string, string> = {
	pending: 'Waiting',
	paid: 'Paid',
	expired: 'Expired',
	cancelled: 'Cancelled',
	matched: 'Matched',
	unmatched: 'Unmatched',
	ambiguous: 'Ambiguous',
	review: 'Needs review',
	ignored: 'Ignored',
	duplicate: 'Duplicate',
	online: 'Online',
	offline: 'Offline',
	revoked: 'Removed',
};

export type Role = 'owner' | 'admin' | 'staff' | 'developer';
export const can = {
	manage: (r: Role) => r === 'owner' || r === 'admin',
	act: (r: Role) => r !== 'developer',
	develop: (r: Role) => r === 'owner' || r === 'admin' || r === 'developer',
};
