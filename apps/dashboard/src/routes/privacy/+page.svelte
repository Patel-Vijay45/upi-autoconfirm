<script lang="ts">
	let { data } = $props();
</script>

<svelte:head><title>Privacy policy · AutoConfirm</title></svelte:head>

<article class="policy">
	<h1>Privacy policy</h1>
	<p class="muted small">Last updated {data.updated}. Covers the AutoConfirm Android app, the merchant dashboard and the payment pages.</p>

	<h2>Who we are</h2>
	<p>
		{#if data.operator}AutoConfirm is run by {data.operator}.{/if} AutoConfirm confirms UPI payments that customers send directly to a shop's own UPI ID.
		We never receive, hold or move money.
		{#if data.email}Questions, requests or complaints (including our grievance contact): <a href="mailto:{data.email}">{data.email}</a>.{/if}
	</p>

	<h2>The Android app (on the shop's counter phone)</h2>
	<p>With the shop owner's permission (Android "notification access"), the app looks at notifications on that phone to see when the shop receives money:</p>
	<ul>
		<li>alerts from payment apps (for example Google Pay, PhonePe Business, Paytm for Business), and</li>
		<li>bank "credited" SMS alerts shown by the messaging app, only from bank sender IDs.</li>
	</ul>
	<p>From a matching notification it keeps only the <strong>amount</strong>, the <strong>time</strong>, a <strong>short payer name</strong> (like "Ramesh P"), the <strong>payment reference</strong> (UTR) if shown, which app it came from, and a one-way fingerprint used to avoid counting the same alert twice. These are sent to the shop's AutoConfirm server to mark the right order as paid.</p>
	<ul>
		<li>Notifications from other apps, other SMS, and the full text of any notification are <strong>never stored or sent</strong>.</li>
		<li>Nothing is read until the phone is paired with a shop, or while sending is paused.</li>
		<li>The app does not ask for SMS, contacts, location, camera, microphone or accessibility permissions.</li>
		<li>To keep the phone working, the app also sends: phone model, Android and app version, whether notification access and battery optimisation are on, how many payments are waiting to send, and the phone's clock (to correct payment times).</li>
	</ul>

	<h2>The dashboard (for shop owners and staff)</h2>
	<ul>
		<li>Your email, role, a hash of your password (never the password itself) and, for owners and admins, an encrypted authenticator secret.</li>
		<li>Login sessions and the IP address of login attempts, to protect accounts from guessing. An activity log of important actions (who marked an order paid, removed a phone, and so on).</li>
		<li>If you turn on alerts, your browser's push-alert address. Alerts are end-to-end encrypted to your browser.</li>
	</ul>

	<h2>Customers paying a shop</h2>
	<p>
		The shop's own website tells us the order number and amount, and may add the customer's name or phone. The payment page shows the amount and the shop's UPI details; the customer pays in their own UPI app.
		We never see UPI PINs, bank account numbers or card details. Customers should contact the shop about their order or a refund; refunds are made by the shop.
	</p>

	<h2>Why we use this data</h2>
	<p>Only to confirm payments, show them to the shop, alert the shop when something needs attention (for example a phone goes offline), keep accounts secure and fix problems. We don't sell data, show ads or build advertising profiles.</p>

	<h2>Who receives it</h2>
	<ul>
		<li><strong>The shop</strong> (merchant) the data belongs to, in its dashboard and on its own website (signed webhooks).</li>
		<li><strong>Cloudflare</strong>, which hosts the service and stores the data on our behalf.</li>
		<li><strong>Browser push services</strong> (Google, Apple, Mozilla, Microsoft) carry alerts you turned on; they can't read them.</li>
	</ul>
	<p>Nobody else, unless the law requires it.</p>

	<h2>How long we keep it</h2>
	<ul>
		<li>Payer names and payment references: 90 days, then blanked (the payment record itself stays, for the shop's accounts).</li>
		<li>Customer name and phone on a payment: 1 year, then blanked.</li>
		<li>Activity log: 1 year (IP addresses: 90 days). Webhook logs: 30 days.</li>
		<li>Login sessions end after 12 hours. On the phone, today's list is cleared after 24 hours and sent payments are removed from the queue straight away.</li>
	</ul>

	<h2 id="delete">Your choices and deleting data</h2>
	<ul>
		<li><strong>On the phone:</strong> tap <em>Unpair this phone</em> in the app. This deletes everything the app stored on the phone and stops the phone from sending. Uninstalling the app does the same. You can also pause sending, or turn off notification access in Android settings at any time.</li>
		<li><strong>Shop accounts:</strong> an owner can remove phones and deactivate users in the dashboard. To delete the whole shop account and its data, {#if data.email}email <a href="mailto:{data.email}?subject=Delete%20my%20AutoConfirm%20data">{data.email}</a>{:else}contact us{/if}; we do it within 30 days (records the law requires us or the shop to keep may stay until that period ends).</li>
		<li><strong>Customers:</strong> ask the shop you paid. The shop can ask us to delete your details.</li>
	</ul>

	<h2>Security</h2>
	<p>All traffic uses HTTPS. Phone, webhook and login secrets are encrypted, API keys are stored only as hashes, owners and admins must use an authenticator app, and every request from a phone is signed.</p>

	<h2>Children</h2>
	<p>AutoConfirm is a business tool for adults. It is not meant for anyone under 18.</p>

	<h2>Changes</h2>
	<p>If we change this policy we'll update the date above, and tell shop owners in the dashboard about important changes.</p>
</article>

<style>
	.policy { max-width: 46rem; margin: 0 auto; line-height: 1.55; }
	.policy h2 { margin-top: 1.6rem; font-size: 1.15rem; }
	.policy ul { padding-left: 1.2rem; }
	.policy li { margin: .3rem 0; }
</style>
