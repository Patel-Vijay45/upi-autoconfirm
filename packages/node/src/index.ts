// @autoconfirm/node: server-side client for UPI AutoConfirm. No dependencies; uses fetch and Web Crypto,
// so it runs on Node 18+, Cloudflare Workers, Deno and Bun. Never use the secret key in a browser.
//
//   const ac = new AutoConfirm(process.env.AUTOCONFIRM_SECRET_KEY, { baseUrl: 'https://api.example.com' });
//   const pi = await ac.paymentIntents.create({ amount: 93000, order_id: 'ORD-1042' }, { idempotencyKey: 'order-ORD-1042' });
//   const event = await ac.webhooks.constructEvent(rawBody, req.headers['autoconfirm-signature'], WEBHOOK_SECRET);

export type IntentStatus = 'pending' | 'paid' | 'expired' | 'cancelled';
export type SignalStatus = 'matched' | 'unmatched' | 'ambiguous' | 'review' | 'ignored' | 'duplicate';

export interface PaymentIntent {
	id: string;
	object: 'payment_intent';
	status: IntentStatus;
	/** Requested amount, integer paise. */
	amount: number;
	/** What the customer pays (amount + paise offset), integer paise. */
	unique_amount: number;
	display_amount: string;
	currency: 'INR';
	order_id: string | null;
	description: string | null;
	location_id: string;
	customer: { name: string | null; phone: string | null } | null;
	created: string;
	expires_at: string;
	paid_at: string | null;
	customer_claimed_at: string | null;
	livemode: boolean;
	checkout_url: string;
	return_url: string | null;
	upi: { uri: string; apps: { gpay: string; phonepe: string; paytm: string }; qr_svg?: string };
	match: {
		source: 'auto' | 'manual';
		signal_id: string | null;
		app: string | null;
		late: boolean;
		amount_mismatch: boolean;
		received_amount: number | null;
	} | null;
	metadata: Record<string, string>;
}

export interface Signal {
	id: string;
	object: 'signal';
	status: SignalStatus;
	location_id: string;
	device_id: string;
	app: string;
	amount: number;
	display_amount: string;
	payer_name: string | null;
	reference: string | null;
	posted_at: string;
	received_at: string;
	payment_intent: string | null;
	duplicate_of: string | null;
	note: string | null;
}

export interface List<T> {
	object: 'list';
	data: T[];
	has_more: boolean;
}

export interface CreatePaymentIntentParams {
	/** Integer paise, e.g. 93000 for ₹930. Never a float. */
	amount: number;
	location_id?: string;
	order_id?: string;
	description?: string;
	customer?: { name?: string; phone?: string };
	/** Seconds (default 900). */
	expires_in?: number;
	return_url?: string;
	metadata?: Record<string, string>;
}

export interface WebhookEvent<T = unknown> {
	id: string;
	object: 'event';
	type: string;
	created: string;
	livemode: boolean;
	data: { object: T };
}

export class AutoConfirmError extends Error {
	constructor(
		readonly status: number,
		readonly type: string,
		readonly code: string,
		message: string,
		readonly param?: string,
	) {
		super(message);
		this.name = 'AutoConfirmError';
	}
}

export class SignatureVerificationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SignatureVerificationError';
	}
}

export interface ClientOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
	/** Retries for network errors and 5xx responses (POSTs only when an idempotency key is set). Default 2. */
	maxRetries?: number;
}

type Query = Record<string, string | number | undefined>;

export class AutoConfirm {
	private readonly baseUrl: string;
	private readonly fetchFn: typeof fetch;
	private readonly maxRetries: number;

	constructor(
		private readonly secretKey: string,
		opts: ClientOptions = {},
	) {
		if (!/^sk_(live|test)_/.test(secretKey ?? '')) throw new Error('AutoConfirm needs a secret key (sk_live_… or sk_test_…)');
		this.baseUrl = (opts.baseUrl ?? 'https://api.example.com').replace(/\/$/, '');
		this.fetchFn = opts.fetch ?? fetch.bind(globalThis);
		this.maxRetries = opts.maxRetries ?? 2;
	}

	readonly paymentIntents = {
		create: (params: CreatePaymentIntentParams, opts: { idempotencyKey?: string } = {}) => {
			if (!Number.isSafeInteger(params.amount)) throw new TypeError('amount must be integer paise (e.g. 93000 for ₹930)');
			return this.request<PaymentIntent>('POST', '/v1/payment_intents', params, opts.idempotencyKey);
		},
		retrieve: (id: string) => this.request<PaymentIntent>('GET', `/v1/payment_intents/${enc(id)}`),
		list: (q: { status?: IntentStatus; location_id?: string; created_after?: string; limit?: number; starting_after?: string } = {}) =>
			this.request<List<PaymentIntent>>('GET', '/v1/payment_intents', undefined, undefined, q),
		cancel: (id: string) => this.request<PaymentIntent>('POST', `/v1/payment_intents/${enc(id)}/cancel`),
		markPaid: (id: string, p: { note?: string; signal_id?: string } = {}) => this.request<PaymentIntent>('POST', `/v1/payment_intents/${enc(id)}/mark_paid`, p),
		unmarkPaid: (id: string, p: { reason: string; status?: 'pending' | 'cancelled' }) => this.request<PaymentIntent>('POST', `/v1/payment_intents/${enc(id)}/unmark_paid`, p),
	};

	readonly signals = {
		list: (q: { status?: SignalStatus; location_id?: string; limit?: number; starting_after?: string } = {}) =>
			this.request<List<Signal>>('GET', '/v1/signals', undefined, undefined, q),
		retrieve: (id: string) => this.request<Signal>('GET', `/v1/signals/${enc(id)}`),
		assign: (id: string, paymentIntent: string) => this.request<PaymentIntent>('POST', `/v1/signals/${enc(id)}/assign`, { payment_intent: paymentIntent }),
		reject: (id: string, reason?: string) => this.request<Signal>('POST', `/v1/signals/${enc(id)}/reject`, reason ? { reason } : {}),
		ignore: (id: string, reason?: string) => this.request<Signal>('POST', `/v1/signals/${enc(id)}/ignore`, reason ? { reason } : {}),
	};

	readonly webhooks = {
		/** Verifies AutoConfirm-Signature (HMAC-SHA256, ±300 s) and parses the event. Pass the RAW request body. */
		constructEvent: <T = unknown>(rawBody: string, header: string | null | undefined, secret: string, toleranceSeconds = 300) =>
			constructEvent<T>(rawBody, header, secret, toleranceSeconds),
	};

	private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string, query?: Query): Promise<T> {
		const qs = query
			? Object.entries(query)
					.filter(([, v]) => v !== undefined)
					.map(([k, v]) => `${enc(k)}=${enc(String(v))}`)
					.join('&')
			: '';
		const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
		const headers: Record<string, string> = { authorization: `Bearer ${this.secretKey}`, 'user-agent': 'autoconfirm-node/0.1.0' };
		if (body !== undefined || method === 'POST') headers['content-type'] = 'application/json';
		if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
		const canRetry = method === 'GET' || Boolean(idempotencyKey);

		for (let attempt = 0; ; attempt++) {
			let res: Response;
			try {
				res = await this.fetchFn(url, { method, headers, body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined });
			} catch (err) {
				if (canRetry && attempt < this.maxRetries) {
					await sleep(300 * 2 ** attempt);
					continue;
				}
				throw err;
			}
			if (res.status >= 500 && canRetry && attempt < this.maxRetries) {
				await sleep(300 * 2 ** attempt);
				continue;
			}
			const text = await res.text();
			const json = text ? (JSON.parse(text) as unknown) : null;
			if (!res.ok) {
				const e = (json as { error?: { type?: string; code?: string; message?: string; param?: string } } | null)?.error ?? {};
				throw new AutoConfirmError(res.status, e.type ?? 'api_error', e.code ?? 'unknown', e.message ?? `HTTP ${res.status}`, e.param);
			}
			return json as T;
		}
	}
}

export async function constructEvent<T = unknown>(rawBody: string, header: string | null | undefined, secret: string, toleranceSeconds = 300): Promise<WebhookEvent<T>> {
	if (!header) throw new SignatureVerificationError('missing AutoConfirm-Signature header');
	let t: number | undefined;
	const sigs: string[] = [];
	for (const part of header.split(',')) {
		const [k, v] = part.trim().split('=', 2);
		if (k === 't' && v && /^\d+$/.test(v)) t = Number(v);
		if (k === 'v1' && v) sigs.push(v);
	}
	if (t === undefined || sigs.length === 0) throw new SignatureVerificationError('malformed AutoConfirm-Signature header');
	if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) throw new SignatureVerificationError('timestamp outside the tolerance window');
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${rawBody}`)));
	const expected = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
	if (!sigs.some((s) => timingSafeEqual(s, expected))) throw new SignatureVerificationError('signature does not match');
	return JSON.parse(rawBody) as WebhookEvent<T>;
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return d === 0;
}

const enc = encodeURIComponent;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
