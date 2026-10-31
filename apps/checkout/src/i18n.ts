// Customer-facing text (docs/MATCHING.md §6). Hindi and Gujarati should be checked by a native speaker.
export type Lang = 'en' | 'hi' | 'gu';

export interface Strings {
	payTo: string; // {payee}
	payExactly: string;
	extraNote: string; // {paise}
	gpay: string;
	phonepe: string;
	paytm: string;
	otherApp: string;
	qrHint: string;
	iHavePaid: string;
	checking: string;
	paid: string;
	stillChecking: string;
	expired: string;
	cancelled: string;
	expiresIn: string; // {time}
	redirecting: string;
	close: string;
}

export const STRINGS: Record<Lang, Strings> = {
	en: {
		payTo: 'Pay {payee}',
		payExactly: 'Pay exactly this amount',
		extraNote: '+{paise} paise helps us confirm your payment automatically.',
		gpay: 'Pay with Google Pay',
		phonepe: 'Pay with PhonePe',
		paytm: 'Pay with Paytm',
		otherApp: 'Other UPI app',
		qrHint: 'Or scan with any UPI app',
		iHavePaid: 'I have paid',
		checking: 'Checking payment… ⏳',
		paid: 'Payment received ✓',
		stillChecking: "Still checking. If money was deducted, show this screen at the counter or contact the shop. Don't pay again.",
		expired: 'This payment request has expired. If you already paid, show this screen at the counter or contact the shop.',
		cancelled: 'This payment request was cancelled.',
		expiresIn: 'Expires in {time}',
		redirecting: 'Taking you back…',
		close: 'Close',
	},
	hi: {
		payTo: '{payee} को भुगतान करें',
		payExactly: 'ठीक यही राशि भरें',
		extraNote: '+{paise} पैसे से आपका भुगतान अपने-आप कन्फ़र्म होता है।',
		gpay: 'Google Pay से भुगतान करें',
		phonepe: 'PhonePe से भुगतान करें',
		paytm: 'Paytm से भुगतान करें',
		otherApp: 'दूसरा UPI ऐप',
		qrHint: 'या किसी भी UPI ऐप से स्कैन करें',
		iHavePaid: 'मैंने भुगतान कर दिया',
		checking: 'भुगतान की जाँच हो रही है… ⏳',
		paid: 'भुगतान मिल गया ✓',
		stillChecking: 'अभी भी जाँच हो रही है। अगर पैसे कट गए हैं, तो यह स्क्रीन काउंटर पर दिखाएँ या दुकान से संपर्क करें। दोबारा भुगतान न करें।',
		expired: 'यह भुगतान अनुरोध समाप्त हो गया है। अगर आपने भुगतान कर दिया है, तो यह स्क्रीन काउंटर पर दिखाएँ या दुकान से संपर्क करें।',
		cancelled: 'यह भुगतान अनुरोध रद्द कर दिया गया है।',
		expiresIn: '{time} में समाप्त',
		redirecting: 'वापस ले जा रहे हैं…',
		close: 'बंद करें',
	},
	gu: {
		payTo: '{payee} ને ચૂકવો',
		payExactly: 'બરાબર આ જ રકમ ચૂકવો',
		extraNote: '+{paise} પૈસા તમારી ચુકવણી આપમેળે કન્ફર્મ કરવામાં મદદ કરે છે.',
		gpay: 'Google Pay થી ચૂકવો',
		phonepe: 'PhonePe થી ચૂકવો',
		paytm: 'Paytm થી ચૂકવો',
		otherApp: 'બીજી UPI એપ',
		qrHint: 'અથવા કોઈપણ UPI એપથી સ્કેન કરો',
		iHavePaid: 'મેં ચુકવણી કરી દીધી છે',
		checking: 'ચુકવણી તપાસી રહ્યા છીએ… ⏳',
		paid: 'ચુકવણી મળી ગઈ ✓',
		stillChecking: 'હજુ તપાસી રહ્યા છીએ. જો પૈસા કપાઈ ગયા હોય, તો આ સ્ક્રીન કાઉન્ટર પર બતાવો અથવા દુકાનનો સંપર્ક કરો. ફરીથી ચુકવણી કરશો નહીં.',
		expired: 'આ ચુકવણી વિનંતી સમાપ્ત થઈ ગઈ છે. જો તમે ચુકવણી કરી દીધી હોય, તો આ સ્ક્રીન કાઉન્ટર પર બતાવો અથવા દુકાનનો સંપર્ક કરો.',
		cancelled: 'આ ચુકવણી વિનંતી રદ કરવામાં આવી છે.',
		expiresIn: '{time} માં સમાપ્ત',
		redirecting: 'પાછા લઈ જઈ રહ્યા છીએ…',
		close: 'બંધ કરો',
	},
};

export function pickLang(input: string | null | undefined): Lang {
	const s = (input ?? '').toLowerCase();
	for (const part of s.split(',')) {
		const code = part.trim().slice(0, 2);
		if (code === 'hi' || code === 'gu' || code === 'en') return code;
	}
	return 'en';
}

export function fill(template: string, vars: Record<string, string | number>): string {
	return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
}
