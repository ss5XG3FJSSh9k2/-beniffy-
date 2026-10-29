const crypto = require('crypto');
const integrations = require('./integrations');

const TEST_PAYMENT_SECRET = 'fastnet_test_payment_secret_key_12345';
const TEST_WEBHOOK_SECRET = 'fastnet_test_webhook_secret_key_12345';

let _razorpayInstance = null;

function getRazorpayInstance() {
  if (_razorpayInstance) return _razorpayInstance;
  const Razorpay = require('razorpay');
  _razorpayInstance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
  return _razorpayInstance;
}

function computeSignature(orderId, paymentId, secret) {
  if (!orderId || !paymentId || !secret) {
    throw new Error('orderId, paymentId, and secret are required to compute signature');
  }
  return crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
}

function generateTestSignature(orderId, paymentId) {
  const secret = process.env.RAZORPAY_KEY_SECRET || TEST_PAYMENT_SECRET;
  return computeSignature(orderId, paymentId, secret);
}

function verifyPaymentSignature({ order_id, payment_id, signature, secret }) {
  if (!order_id || !payment_id || !signature) return false;
  const mode = integrations.getPaymentsMode();
  const secretKey = secret || (mode === 'live' ? process.env.RAZORPAY_KEY_SECRET : (process.env.RAZORPAY_KEY_SECRET || TEST_PAYMENT_SECRET));
  if (!secretKey) return false;

  try {
    const expected = computeSignature(order_id, payment_id, secretKey);
    const sigBuf = Buffer.from(signature, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch (err) {
    return false;
  }
}

function verifyWebhookSignature(rawBody, signature, secret) {
  if (!rawBody || !signature) return false;
  const mode = integrations.getPaymentsMode();
  const secretKey = secret || (mode === 'live' ? process.env.RAZORPAY_WEBHOOK_SECRET : (process.env.RAZORPAY_WEBHOOK_SECRET || TEST_WEBHOOK_SECRET));
  if (!secretKey) return false;

  try {
    const bodyStr = typeof rawBody === 'string' ? rawBody : (Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : JSON.stringify(rawBody));
    const expected = crypto.createHmac('sha256', secretKey).update(bodyStr).digest('hex');
    const sigBuf = Buffer.from(signature, 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch (err) {
    return false;
  }
}

async function createPaymentOrder({ orderId, amount, currency = 'INR', notes = {}, linkedAccountId = null, transferAmount = null }) {
  const mode = integrations.getPaymentsMode();
  if (mode === 'live') {
    const missing = integrations.getMissingPaymentsKeys();
    if (missing.length > 0) {
      throw new Error(`Cannot create live Razorpay order. Missing keys: ${missing.join(', ')}`);
    }
    const instance = getRazorpayInstance();
    const options = {
      amount: Math.round(Number(amount) * 100),
      currency: currency || 'INR',
      receipt: String(orderId),
      notes: { orderId: String(orderId), ...notes }
    };
    if (linkedAccountId) {
      options.transfers = [
        {
          account: linkedAccountId,
          amount: Math.round((Number(transferAmount) || Number(amount)) * 100),
          currency: currency || 'INR',
          on_hold: 1
        }
      ];
    }
    const rzpOrder = await instance.orders.create(options);
    return {
      id: rzpOrder.id,
      entity: rzpOrder.entity,
      amount: rzpOrder.amount,
      currency: rzpOrder.currency,
      receipt: rzpOrder.receipt,
      status: rzpOrder.status,
      checkout_url: null,
      raw: rzpOrder
    };
  }

  // Test driver
  const cleanId = String(orderId).replace(/^o-/, '');
  const fakeOrderId = `rzp_order_test_${cleanId}_${Date.now()}`;
  return {
    id: fakeOrderId,
    entity: 'order',
    amount: Math.round(Number(amount) * 100),
    currency: currency || 'INR',
    receipt: String(orderId),
    status: 'created',
    checkout_url: `/pay/test/${orderId}`,
    notes: { orderId: String(orderId), ...notes }
  };
}

async function releaseTransfer({ order, splitPayout, stockist }) {
  const mode = integrations.getPaymentsMode();
  const payoutAmount = splitPayout ? parseFloat(splitPayout.stockist_amount) : 0;

  if (mode === 'live') {
    const instance = getRazorpayInstance();
    const accountId = stockist?.linked_account_id || stockist?.linked_account;
    if (!accountId) {
      throw new Error(`Stockist ${stockist?.id || order?.stockist_id} has no linked_account_id configured for Route transfers`);
    }

    if (order.razorpay_transfer_id) {
      const res = await instance.transfers.setHold(order.razorpay_transfer_id, { on_hold: 0 });
      return { success: true, transfer_id: order.razorpay_transfer_id, details: res };
    }

    if (!order.razorpay_payment_id) {
      throw new Error(`Order ${order.id} has no razorpay_payment_id to transfer from`);
    }

    const res = await instance.payments.transfer(order.razorpay_payment_id, {
      transfers: [
        {
          account: accountId,
          amount: Math.round(payoutAmount * 100),
          currency: 'INR',
          on_hold: 0
        }
      ]
    });
    const transferId = res?.items?.[0]?.id || res?.transfers?.[0]?.id || ('trf_' + Date.now());
    return { success: true, transfer_id: transferId, details: res };
  }

  // Test driver
  return {
    success: true,
    transfer_id: `trf_test_${order.id || Date.now()}`,
    amount: payoutAmount,
    status: 'processed'
  };
}

async function refundPayment({ orderId, paymentId, amount, reason }) {
  const mode = integrations.getPaymentsMode();
  const refundAmount = parseFloat(amount);

  if (mode === 'live') {
    if (!paymentId) {
      throw new Error(`Cannot refund order ${orderId}: no paymentId found`);
    }
    const instance = getRazorpayInstance();
    const rzpRefund = await instance.payments.refund(paymentId, {
      amount: Math.round(refundAmount * 100),
      notes: { orderId: String(orderId), reason: reason || 'Refund' }
    });
    return {
      success: true,
      refund_id: rzpRefund.id,
      amount: refundAmount,
      raw: rzpRefund
    };
  }

  // Test driver
  return {
    success: true,
    refund_id: `rfnd_test_${Date.now()}`,
    amount: refundAmount,
    status: 'processed'
  };
}

function getCheckoutUrl(orderId) {
  const mode = integrations.getPaymentsMode();
  if (mode === 'test') {
    return `/pay/test/${orderId}`;
  }
  return null;
}

module.exports = {
  TEST_PAYMENT_SECRET,
  TEST_WEBHOOK_SECRET,
  computeSignature,
  generateTestSignature,
  verifyPaymentSignature,
  verifyWebhookSignature,
  createPaymentOrder,
  releaseTransfer,
  refundPayment,
  getCheckoutUrl
};
