"""AutoConfirm: Python / Flask example (same idea for Django or FastAPI).
pip install flask requests
AUTOCONFIRM_SECRET_KEY=sk_test_xxx AUTOCONFIRM_WEBHOOK_SECRET=whsec_xxx flask --app python-flask run
"""
import hashlib
import hmac
import os
import time

import requests
from flask import Flask, abort, jsonify, request

API = "https://api.example.com/v1"
SK = os.environ["AUTOCONFIRM_SECRET_KEY"]
WHSEC = os.environ["AUTOCONFIRM_WEBHOOK_SECRET"]
app = Flask(__name__)


@app.post("/api/create-upi-payment")
def create_payment():
    order = load_order(request.json["orderId"])  # your DB
    r = requests.post(
        f"{API}/payment_intents",
        headers={"Authorization": f"Bearer {SK}", "Idempotency-Key": f"order-{order['id']}"},
        json={"amount": order["total_paise"], "order_id": order["id"],
              "return_url": f"https://yoursite.com/order/{order['id']}"},
        timeout=15,
    )
    if r.status_code not in (200, 201):
        abort(502)
    intent = r.json()
    save_intent_on_order(order["id"], intent["id"])
    return jsonify(intentId=intent["id"], checkoutUrl=intent["checkout_url"])


def verify(raw: bytes, header: str | None, secret: str) -> bool:
    if not header:
        return False
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    try:
        t = int(parts.get("t", "0"))
    except ValueError:
        return False
    if abs(time.time() - t) > 300:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))


@app.post("/webhooks/autoconfirm")
def webhook():
    raw = request.get_data()  # raw bytes, before any JSON parsing
    if not verify(raw, request.headers.get("AutoConfirm-Signature"), WHSEC):
        abort(400)
    event = request.get_json()
    if already_processed(event["id"]):
        return "", 200
    if event["type"] == "payment_intent.paid":
        pi = event["data"]["object"]
        order = load_order(pi["order_id"])
        if order and order["total_paise"] == pi["amount"]:
            mark_order_paid(order["id"], pi["id"])
    remember_processed(event["id"])
    return "", 200


# --- your app's functions (stubs) ---
def load_order(order_id): return {"id": order_id, "total_paise": 93000}
def save_intent_on_order(order_id, intent_id): pass
def mark_order_paid(order_id, intent_id): pass
def already_processed(event_id): return False
def remember_processed(event_id): pass
