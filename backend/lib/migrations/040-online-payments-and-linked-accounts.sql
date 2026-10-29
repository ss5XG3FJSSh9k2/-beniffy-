-- Round Online Payments: 040-online-payments-and-linked-accounts.sql
ALTER TABLE stockists ADD COLUMN IF NOT EXISTS linked_account_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS razorpay_transfer_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS transfer_released BOOLEAN DEFAULT false;
