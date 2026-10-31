/** Everything the checkout UI shows. No customer personal data. */
export interface CheckoutView {
	id: string;
	status: 'pending' | 'paid' | 'expired' | 'cancelled';
	amount: number;
	unique_amount: number;
	display_amount: string;
	payee_name: string;
	order_id: string | null;
	expires_at: string;
	paid_at: string | null;
	return_url: string | null;
	upi: { uri: string; apps: { gpay: string; phonepe: string; paytm: string } };
	qr_svg: string;
}

export interface StatusUpdate {
	status: CheckoutView['status'];
	paid_at: string | null;
	expires_at?: string;
}
