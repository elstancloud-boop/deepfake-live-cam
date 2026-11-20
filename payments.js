import crypto from "crypto";

// Price per minute of swapping, in USD. Fast mode burns minutes at 2x.
export const PRICE_PER_MIN = Number(process.env.PRICE_PER_MIN || 10);

// Each provider: createInvoice(order, urls) -> { url, ref }, verifyWebhook(req) -> { orderId, paid } | null
export const providers = {
  nowpayments: {
    async createInvoice(order, { ipnUrl, successUrl, cancelUrl }) {
      const r = await fetch("https://api.nowpayments.io/v1/invoice", {
        method: "POST",
        headers: { "x-api-key": process.env.NOWPAYMENTS_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          price_amount: Number(order.usd), price_currency: "usd", order_id: order.id,
          order_description: `${order.minutes} live-cam minutes`,
          ipn_callback_url: ipnUrl, success_url: successUrl, cancel_url: cancelUrl,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.invoice_url) throw new Error("nowpayments: " + JSON.stringify(j));
      return { url: j.invoice_url, ref: String(j.id) };
    },
    // IPN signature: HMAC-SHA512 over the JSON body with keys sorted, using the IPN secret.
    verifyWebhook(req) {
      const sorted = o => Array.isArray(o) ? o.map(sorted)
        : o && typeof o === "object" ? Object.fromEntries(Object.keys(o).sort().map(k => [k, sorted(o[k])])) : o;
      const expected = crypto.createHmac("sha512", process.env.NOWPAYMENTS_IPN_SECRET || "")
        .update(JSON.stringify(sorted(req.body))).digest("hex");
      const got = String(req.get("x-nowpayments-sig") || "");
      if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return null;
      return { orderId: req.body.order_id, paid: req.body.payment_status === "finished" };
    },
  },
  // TODO: add the second gateway here once its name and API docs are confirmed.
};
