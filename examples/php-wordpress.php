<?php
/**
 * AutoConfirm: plain PHP / WordPress example.
 * Put the keys in wp-config.php (never in theme files):
 *   define('AUTOCONFIRM_SECRET_KEY', 'sk_test_xxx');
 *   define('AUTOCONFIRM_WEBHOOK_SECRET', 'whsec_xxx');
 */

const AUTOCONFIRM_API = 'https://api.example.com/v1';

/** 1. Create a payment intent for an order. Returns the decoded intent or null. */
function autoconfirm_create_intent(string $order_id, int $amount_paise, string $return_url): ?array {
    $ch = curl_init(AUTOCONFIRM_API . '/payment_intents');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_HTTPHEADER => [
            'Authorization: Bearer ' . AUTOCONFIRM_SECRET_KEY,
            'Content-Type: application/json',
            'Idempotency-Key: order-' . $order_id,
        ],
        CURLOPT_POSTFIELDS => json_encode([
            'amount' => $amount_paise,
            'order_id' => $order_id,
            'return_url' => $return_url,
        ]),
    ]);
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($status !== 201 && $status !== 200) return null;
    return json_decode($body, true);
}

/** 2. Verify a webhook signature. $raw must be the exact request body. */
function autoconfirm_verify(string $raw, ?string $header, string $secret): bool {
    if (!$header) return false;
    $parts = [];
    foreach (explode(',', $header) as $p) {
        [$k, $v] = array_pad(explode('=', $p, 2), 2, '');
        $parts[trim($k)] = trim($v);
    }
    $t = intval($parts['t'] ?? 0);
    if ($t === 0 || abs(time() - $t) > 300) return false;
    $expected = hash_hmac('sha256', $t . '.' . $raw, $secret);
    return hash_equals($expected, $parts['v1'] ?? '');
}

/** 3. Webhook endpoint, e.g. https://yoursite.com/?autoconfirm_webhook=1 (or a REST route). */
if (isset($_GET['autoconfirm_webhook'])) {
    $raw = file_get_contents('php://input');
    $sig = $_SERVER['HTTP_AUTOCONFIRM_SIGNATURE'] ?? null;
    if (!autoconfirm_verify($raw, $sig, AUTOCONFIRM_WEBHOOK_SECRET)) {
        http_response_code(400);
        exit('bad signature');
    }
    $event = json_decode($raw, true);
    if (($event['type'] ?? '') === 'payment_intent.paid') {
        $pi = $event['data']['object'];
        // WooCommerce example:
        // $order = wc_get_order($pi['order_id']);
        // if ($order && !$order->is_paid() && intval(round($order->get_total() * 100)) === $pi['amount']) {
        //     $order->payment_complete($pi['id']);   // idempotent in WooCommerce
        // }
    }
    http_response_code(200);
    exit('ok');
}
