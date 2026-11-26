
const db = require('../db');
const payments = require('../lib/payments');
const { appendPaymentEvent, createNotification } = require('../lib/audit');
const { escapeHtml } = require('../lib/validation');

const { enrichOrder, _sendOrderConfirmedSms } = require('../services/orders');

function registerPaymentRoutes(app) {
app.get('/pay/test/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const orders = await db.getTable('orders');
  const order = orders.find(o => o.id === orderId);

  if (!order) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html>
      <head><title>Order Not Found</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family:sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
        <div style="background:#1e293b;padding:2rem;border-radius:12px;border:1px solid #334155;text-align:center;">
          <h2>Order Not Found</h2>
          <p>Order ${escapeHtml(orderId)} could not be located.</p>
          <a href="/" style="display:inline-block;margin-top:1rem;color:#38bdf8;text-decoration:none;">&larr; Return to store</a>
        </div>
      </body>
      </html>
    `);
  }

  const isAlreadyPaid = order.payment_status === 'PAID_ONLINE';
  const amountToPay = (order.amount_paid !== undefined && order.amount_paid !== null ? order.amount_paid : order.total_price).toFixed(2);
  const gatewayOrderId = order.razorpay_order_id || ('order_test_' + order.id);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Test Payment Gateway — Razorpay Simulator</title>
      <style>
        * { box-sizing: border-box; }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          background: #090d16;
          color: #f1f5f9;
          margin: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          padding: 1rem;
        }
        .card {
          background: #111827;
          border: 1px solid #1f2937;
          border-radius: 16px;
          max-width: 440px;
          width: 100%;
          padding: 2rem;
          box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
        }
        .badge {
          display: inline-block;
          font-size: 0.7rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          padding: 0.25rem 0.6rem;
          border-radius: 9999px;
          background: #312e81;
          color: #a5b4fc;
          margin-bottom: 1rem;
        }
        h1 { font-size: 1.25rem; margin: 0 0 0.5rem 0; font-weight: 600; }
        .amount-box {
          background: #1e293b;
          border: 1px solid #334155;
          border-radius: 12px;
          padding: 1.25rem;
          margin: 1.25rem 0;
          text-align: center;
        }
        .amount {
          font-size: 2rem;
          font-weight: 700;
          color: #38bdf8;
        }
        .details {
          font-size: 0.85rem;
          color: #94a3b8;
          margin-bottom: 1.5rem;
          line-height: 1.6;
        }
        .details strong { color: #f8fafc; }
        .btn {
          width: 100%;
          padding: 0.85rem;
          border-radius: 8px;
          font-size: 0.95rem;
          font-weight: 600;
          cursor: pointer;
          border: none;
          transition: all 0.2s;
          margin-bottom: 0.75rem;
        }
        .btn-success {
          background: #10b981;
          color: #ffffff;
        }
        .btn-success:hover { background: #059669; }
        .btn-fail {
          background: #374151;
          color: #fca5a5;
          border: 1px solid #ef4444;
        }
        .btn-fail:hover { background: #4b5563; }
        .note {
          font-size: 0.75rem;
          color: #64748b;
          text-align: center;
          margin-top: 1rem;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <span class="badge">Razorpay Test Simulator</span>
        <h1>Payment Gateway Checkout</h1>
        <div class="details">
          <div>Order: <strong>#${escapeHtml(order.id)}</strong></div>
          <div>Store: <strong>${escapeHtml(order.stockist_name || 'Stockist Store')}</strong></div>
        </div>

        <div class="amount-box">
          <div style="font-size: 0.8rem; color: #94a3b8; margin-bottom: 0.25rem;">Amount Due</div>
          <div class="amount">₹${amountToPay}</div>
        </div>

        ${isAlreadyPaid ? `
          <div style="background:#064e3b;color:#a7f3d0;padding:1rem;border-radius:8px;text-align:center;margin-bottom:1rem;">
            Order is already paid online.
          </div>
          <button class="btn btn-success" onclick="window.location.href='/'">Return to Application</button>
        ` : `
          <button id="pay-success-btn" class="btn btn-success" onclick="simulateSuccess()">Pay successfully</button>
          <button id="pay-fail-btn" class="btn btn-fail" onclick="simulateFailure()">Fail payment</button>
        `}

        <div class="note">
          Simulated Razorpay transaction for dev/test environment. Real payments require PAYMENTS_MODE=live.
        </div>
      </div>

      <script>
        const ORDER_ID = ${JSON.stringify(order.id)};
        const GATEWAY_ORDER_ID = ${JSON.stringify(gatewayOrderId)};

        async function simulateSuccess() {
          const btn = document.getElementById('pay-success-btn');
          if (btn) { btn.disabled = true; btn.innerText = 'Processing payment...'; }
          try {
            const callbackRes = await fetch('/api/payments/test-callback', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                order_id: ORDER_ID,
                gateway_order_id: GATEWAY_ORDER_ID
              })
            });
            const data = await callbackRes.json();
            if (data.success) {
              window.location.href = '/?payment=success&orderId=' + encodeURIComponent(ORDER_ID);
            } else {
              alert('Payment verification failed: ' + (data.error || 'Unknown error'));
              if (btn) { btn.disabled = false; btn.innerText = 'Pay successfully'; }
            }
          } catch (err) {
            alert('Network error during payment verification');
            if (btn) { btn.disabled = false; btn.innerText = 'Pay successfully'; }
          }
        }

        async function simulateFailure() {
          const btn = document.getElementById('pay-fail-btn');
          if (btn) { btn.disabled = true; btn.innerText = 'Cancelling payment...'; }
          try {
            await fetch('/api/payments/fail', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                order_id: ORDER_ID,
                reason: 'Customer chose to fail payment in test gateway'
              })
            });
            window.location.href = '/?payment=failed&orderId=' + encodeURIComponent(ORDER_ID);
          } catch (err) {
            window.location.href = '/?payment=failed&orderId=' + encodeURIComponent(ORDER_ID);
          }
        }
      </script>
    </body>
    </html>
  `);
});

// Test callback helper that generates legitimate test signature and verifies (or handles test failure)
app.post('/api/payments/test-callback', async (req, res) => {
  const { order_id, orderId, gateway_order_id, action, reason } = req.body;
  const targetOrderId = order_id || orderId;
  if (!targetOrderId) {
    return res.status(400).json({ error: 'Missing order_id' });
  }

  const orders = await db.getTable('orders');
  const order = orders.find(o => o.id === targetOrderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (action === 'fail' || action === 'failed') {
    if (order.payment_status === 'PAID_ONLINE') {
      return res.status(400).json({ error: 'Cannot fail an order that is already paid' });
    }
    order.payment_status = 'PAYMENT_FAILED';
    await db.saveTable('orders', orders);

    const splitPayouts = await db.getTable('split_payouts');
    let spChanged = false;
    for (const sp of splitPayouts) {
      if (sp.order_id === order.id && sp.status !== 'CANCELLED') {
        sp.status = 'CANCELLED';
        spChanged = true;
      }
    }
    if (spChanged) await db.saveTable('split_payouts', splitPayouts);

    appendPaymentEvent(order.id, 'PAYMENT_FAILED', 0, {
      method: 'ONLINE',
      reason: reason || 'Test callback simulated failure'
    });

    const enriched = await enrichOrder(order, req);
    return res.json({
      success: true,
      payment_status: 'PAYMENT_FAILED',
      order: enriched,
      ...enriched
    });
  }

  const effectiveGatewayOrderId = gateway_order_id || order.razorpay_order_id || ('order_test_' + order.id);
  const paymentId = 'pay_test_' + Math.random().toString(36).substring(2, 12);
  const signature = payments.generateTestSignature(effectiveGatewayOrderId, paymentId);

  const isValid = payments.verifyPaymentSignature({
    order_id: effectiveGatewayOrderId,
    payment_id: paymentId,
    signature
  });
  if (!isValid) return res.status(400).json({ error: 'Signature verification failed' });

  order.payment_status = 'PAID_ONLINE';
  order.razorpay_payment_id = paymentId;
  order.razorpay_order_id = effectiveGatewayOrderId;
  order.paid_at = new Date().toISOString();
  await db.saveTable('orders', orders);

  const splitPayouts = await db.getTable('split_payouts');
  let spChanged = false;
  for (const sp of splitPayouts) {
    if (sp.order_id === order.id) {
      sp.status = 'HELD';
      spChanged = true;
    }
  }
  if (spChanged) await db.saveTable('split_payouts', splitPayouts);

  appendPaymentEvent(order.id, 'PAID_ONLINE', order.amount_paid, {
    method: 'ONLINE',
    gateway_order_id: effectiveGatewayOrderId,
    gateway_payment_id: paymentId
  });

  try {
    const stockists = await db.getTable('stockists');
    const stockistRow = stockists.find(s => s.id === order.stockist_id);
    if (stockistRow && stockistRow.user_id) {
      await createNotification({
        userId: stockistRow.user_id,
        type: 'new_order',
        title: 'New order',
        body: `Order #${order.id} received`,
        link: `order:${order.id}`
      });
    }
  } catch (err) {
    console.error('[payment:test-callback] Notification error:', err);
  }
  await _sendOrderConfirmedSms(order);

  const enriched = await enrichOrder(order, req);
  return res.json({
    success: true,
    payment_status: 'PAID_ONLINE',
    razorpay_payment_id: paymentId,
    order: enriched,
    ...enriched
  });
});

// Verify payment signature (works for both test driver and Razorpay gateway)
app.post('/api/payments/verify', async (req, res) => {
  const targetOrderId = req.body.order_id || req.body.orderId;
  const gwOrderId = req.body.gateway_order_id || req.body.razorpay_order_id;
  const gwPaymentId = req.body.gateway_payment_id || req.body.razorpay_payment_id;
  const signature = req.body.signature || req.body.razorpay_signature;

  if (!targetOrderId || !gwOrderId || !gwPaymentId || !signature) {
    return res.status(400).json({ error: 'Missing required payment verification fields' });
  }

  const orders = await db.getTable('orders');
  const order = orders.find(o => o.id === targetOrderId);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const isValid = payments.verifyPaymentSignature({
    order_id: gwOrderId,
    payment_id: gwPaymentId,
    signature
  });

  if (!isValid) {
    return res.status(400).json({ error: 'Invalid payment signature' });
  }

  if (order.payment_status === 'PAID_ONLINE') {
    return res.json({ success: true, order: await enrichOrder(order, req), already_paid: true });
  }

  order.payment_status = 'PAID_ONLINE';
  order.razorpay_payment_id = gwPaymentId;
  order.razorpay_order_id = gwOrderId;
  order.paid_at = new Date().toISOString();
  await db.saveTable('orders', orders);

  const splitPayouts = await db.getTable('split_payouts');
  let spChanged = false;
  for (const sp of splitPayouts) {
    if (sp.order_id === order.id) {
      sp.status = 'HELD';
      spChanged = true;
    }
  }
  if (spChanged) await db.saveTable('split_payouts', splitPayouts);

  appendPaymentEvent(order.id, 'PAID_ONLINE', order.amount_paid, {
    method: 'ONLINE',
    gateway_order_id: gwOrderId,
    gateway_payment_id: gwPaymentId
  });

  try {
    const stockists = await db.getTable('stockists');
    const stockistRow = stockists.find(s => s.id === order.stockist_id);
    if (stockistRow && stockistRow.user_id) {
      await createNotification({
        userId: stockistRow.user_id,
        type: 'new_order',
        title: 'New order',
        body: `Order #${order.id} received`,
        link: `order:${order.id}`
      });
    }
  } catch (err) {
    console.error('[payment:verify] Notification error:', err);
  }
  await _sendOrderConfirmedSms(order);

  return res.json({ success: true, order: await enrichOrder(order, req) });
});

// Fail payment
app.post('/api/payments/fail', async (req, res) => {
  const { order_id, reason } = req.body;
  if (!order_id) return res.status(400).json({ error: 'order_id is required' });

  const orders = await db.getTable('orders');
  const order = orders.find(o => o.id === order_id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.payment_status === 'PAID_ONLINE') {
    return res.status(400).json({ error: 'Cannot fail an order that is already paid' });
  }

  order.payment_status = 'PAYMENT_FAILED';
  await db.saveTable('orders', orders);

  const splitPayouts = await db.getTable('split_payouts');
  let spChanged = false;
  for (const sp of splitPayouts) {
    if (sp.order_id === order.id && sp.status !== 'CANCELLED') {
      sp.status = 'CANCELLED';
      spChanged = true;
    }
  }
  if (spChanged) {
    await db.saveTable('split_payouts', splitPayouts);
  }

  appendPaymentEvent(order.id, 'PAYMENT_FAILED', order.amount_paid, {
    reason: reason || 'Payment failed'
  });

  return res.json({ success: true, order: await enrichOrder(order, req) });
});

// Razorpay webhook
app.post('/api/payments/webhook', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.rawBody || JSON.stringify(req.body);

  if (!payments.verifyWebhookSignature(rawBody, signature)) {
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  const event = req.body;
  const eventName = event.event;
  const payload = event.payload || {};

  if (eventName === 'order.paid' || eventName === 'payment.captured') {
    const payment = payload.payment?.entity || {};
    const gatewayOrderId = payment.order_id;
    const gatewayPaymentId = payment.id;
    const orders = await db.getTable('orders');
    const order = orders.find(o => o.razorpay_order_id === gatewayOrderId || o.id === payment.notes?.orderId);
    if (order && order.payment_status !== 'PAID_ONLINE') {
      order.payment_status = 'PAID_ONLINE';
      order.razorpay_payment_id = gatewayPaymentId;
      order.paid_at = new Date().toISOString();
      await db.saveTable('orders', orders);

      const splitPayouts = await db.getTable('split_payouts');
      let spChanged = false;
      for (const sp of splitPayouts) {
        if (sp.order_id === order.id) {
          sp.status = 'HELD';
          spChanged = true;
        }
      }
      if (spChanged) await db.saveTable('split_payouts', splitPayouts);

      appendPaymentEvent(order.id, 'PAID_ONLINE', order.amount_paid, {
        method: 'ONLINE',
        source: 'webhook',
        gateway_order_id: gatewayOrderId,
        gateway_payment_id: gatewayPaymentId
      });

      try {
        const stockists = await db.getTable('stockists');
        const stockistRow = stockists.find(s => s.id === order.stockist_id);
        if (stockistRow && stockistRow.user_id) {
          await createNotification({
            userId: stockistRow.user_id,
            type: 'new_order',
            title: 'New order',
            body: `Order #${order.id} received`,
            link: `order:${order.id}`
          });
        }
      } catch (err) {
        console.error('[payment:webhook] Notification error:', err);
      }
      await _sendOrderConfirmedSms(order);
    }
  } else if (eventName === 'payment.failed') {
    const payment = payload.payment?.entity || {};
    const gatewayOrderId = payment.order_id;
    const orders = await db.getTable('orders');
    const order = orders.find(o => o.razorpay_order_id === gatewayOrderId || o.id === payment.notes?.orderId);
    if (order && order.payment_status !== 'PAID_ONLINE') {
      order.payment_status = 'PAYMENT_FAILED';
      await db.saveTable('orders', orders);

      const splitPayouts = await db.getTable('split_payouts');
      let spChanged = false;
      for (const sp of splitPayouts) {
        if (sp.order_id === order.id && sp.status !== 'CANCELLED') {
          sp.status = 'CANCELLED';
          spChanged = true;
        }
      }
      if (spChanged) await db.saveTable('split_payouts', splitPayouts);

      appendPaymentEvent(order.id, 'PAYMENT_FAILED', order.amount_paid, {
        source: 'webhook',
        reason: payment.error_description || 'Payment failed'
      });
    }
  }

  return res.json({ status: 'ok' });
});
}

module.exports = { registerPaymentRoutes };
