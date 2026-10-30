-- Round PG: 001-initial.sql
-- Initial relational schema for FastNet Loyalty Platform

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT,
  code TEXT,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  name TEXT,
  code TEXT,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  region_id TEXT,
  phone TEXT,
  email TEXT,
  name TEXT,
  role TEXT,
  password_hash TEXT,
  setup_completed_at TIMESTAMPTZ,
  kyc_status TEXT,
  no_show_count INT DEFAULT 0,
  prepaid_pickup_restricted BOOLEAN DEFAULT false,
  address TEXT,
  kyc_details JSONB,
  is_active BOOLEAN DEFAULT true,
  flags JSONB,
  whatsapp_opt_in BOOLEAN DEFAULT false,
  whatsapp_opt_in_at TIMESTAMPTZ,
  rating NUMERIC(3,2),
  ratings_count INT,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS stockists (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  region_id TEXT,
  user_id TEXT,
  name TEXT,
  vendor_id TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  delivery_radius_km NUMERIC(5,2),
  min_order_value NUMERIC(12,2),
  is_active BOOLEAN DEFAULT true,
  opening_time TEXT,
  closing_time TEXT,
  prep_eta_minutes INT,
  linked_account_id TEXT,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  region_id TEXT,
  stockist_id TEXT,
  name TEXT,
  category TEXT,
  price NUMERIC(12,2),
  cost_price NUMERIC(12,2),
  description TEXT,
  image_url TEXT,
  latest_bill_photo_id TEXT,
  has_flagged_bill BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  cart_id TEXT,
  tenant_id TEXT,
  region_id TEXT,
  customer_id TEXT,
  stockist_id TEXT,
  stockist_name TEXT,
  status TEXT,
  subtotal NUMERIC(12,2),
  delivery_fee NUMERIC(12,2),
  low_order_fee NUMERIC(12,2),
  total_price NUMERIC(12,2),
  total_amount NUMERIC(12,2),
  fulfillment_type TEXT,
  pickup_slot TEXT,
  pickup_eta_minutes INT,
  pickup_pin TEXT,
  payment_status TEXT,
  payment_method TEXT,
  commission_model TEXT,
  config_row_id TEXT,
  platform_commission NUMERIC(12,2),
  points_credited NUMERIC(12,2),
  stockist_reinvest NUMERIC(12,2),
  platform_pot NUMERIC(12,2),
  stockist_payout NUMERIC(12,2),
  margin NUMERIC(12,2),
  earn_rate_used NUMERIC(5,2),
  cancel_deadline TIMESTAMPTZ,
  no_show_count INT DEFAULT 0,
  reschedule_used BOOLEAN DEFAULT false,
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT,
  razorpay_transfer_id TEXT,
  transfer_released BOOLEAN DEFAULT false,
  split_released BOOLEAN DEFAULT false,
  items JSONB,
  pin TEXT,
  verified_at TIMESTAMPTZ,
  refund_amount NUMERIC(12,2),
  refund_id TEXT,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS points_ledger (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  region_id TEXT,
  customer_id TEXT,
  amount NUMERIC(12,2),
  type TEXT,
  redemption_type TEXT,
  source TEXT,
  admin_id TEXT,
  reason TEXT,
  reference_id TEXT,
  order_id TEXT,
  description TEXT,
  billing_sync_status TEXT,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS inventory (
  id TEXT PRIMARY KEY,
  stockist_id TEXT,
  product_id TEXT,
  stock_quantity INT DEFAULT 0,
  stock_qty INT DEFAULT 0,
  is_available BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS stockist_inventory (
  id TEXT PRIMARY KEY,
  stockist_id TEXT,
  product_id TEXT,
  stock_quantity INT DEFAULT 0,
  stock_qty INT DEFAULT 0,
  is_available BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  product_id TEXT,
  name TEXT,
  product_name TEXT,
  quantity INT,
  price NUMERIC(12,2),
  cost_price NUMERIC(12,2),
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS split_payouts (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  stockist_id TEXT,
  stockist_amount NUMERIC(12,2),
  platform_amount NUMERIC(12,2),
  commission_rate_used NUMERIC(5,2),
  earn_rate_used NUMERIC(5,2),
  gross_v1_rate_used NUMERIC(5,2),
  status TEXT,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS payment_ledger (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  event_type TEXT,
  amount NUMERIC(12,2),
  metadata JSONB,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS cod_commission_ledger (
  id TEXT PRIMARY KEY,
  stockist_id TEXT,
  order_id TEXT,
  amount_owed NUMERIC(12,2),
  settled BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS anomaly_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  region_id TEXT,
  customer_id TEXT,
  customer_name TEXT,
  stockist_id TEXT,
  stockist_name TEXT,
  order_id TEXT,
  rules_fired JSONB,
  metric_values JSONB,
  reason TEXT,
  anomaly_type TEXT,
  description TEXT,
  severity TEXT,
  status TEXT,
  dismissed BOOLEAN DEFAULT false,
  dismiss_reason TEXT,
  dismiss_at TIMESTAMPTZ,
  investigated BOOLEAN DEFAULT false,
  dismissed_by TEXT,
  dismissed_reason TEXT,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS stockist_vendors (
  id TEXT PRIMARY KEY,
  stockist_id TEXT,
  vendor_id TEXT,
  approved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS commission_rates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  region_id TEXT,
  category TEXT,
  rate_percent NUMERIC(5,2),
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS stockist_commission_rates (
  id TEXT PRIMARY KEY,
  stockist_id TEXT,
  rate_percent NUMERIC(5,2),
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS points_earn_config (
  id TEXT PRIMARY KEY,
  region_id TEXT,
  stockist_id TEXT,
  earn_rate_percent NUMERIC(5,2),
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS feedback_reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT,
  reporter_role TEXT,
  reporter_stockist_id TEXT,
  target_id TEXT,
  target_role TEXT,
  customer_id TEXT,
  stockist_id TEXT,
  order_id TEXT,
  rating INT,
  reason TEXT,
  report_flag BOOLEAN DEFAULT false,
  feedback_text TEXT,
  status TEXT,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  region_id TEXT,
  name TEXT,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS partner_leads (
  id TEXT PRIMARY KEY,
  name TEXT,
  phone TEXT,
  email TEXT,
  notes JSONB,
  status TEXT,
  promoted_partner_id TEXT,
  promoted_by_admin_id TEXT,
  promoted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS fraud_reports (
  id TEXT PRIMARY KEY,
  reporter_customer_id TEXT,
  subject TEXT,
  description TEXT,
  linked_entity_type TEXT,
  linked_entity_id TEXT,
  reporter_id TEXT,
  reporter_role TEXT,
  target_id TEXT,
  target_role TEXT,
  customer_id TEXT,
  stockist_id TEXT,
  order_id TEXT,
  reason TEXT,
  status TEXT,
  admin_notes TEXT,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT,
  admin_id TEXT,
  user_id TEXT,
  action TEXT,
  entity_type TEXT,
  entity_id TEXT,
  before JSONB,
  after JSONB,
  before_state JSONB,
  after_state JSONB,
  reason TEXT,
  notes TEXT,
  details JSONB,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS commission_config (
  id TEXT PRIMARY KEY,
  scope TEXT,
  stockist_id TEXT,
  stockist_reinvest_pct NUMERIC(5,2),
  points_from_pot_pct NUMERIC(5,2),
  partner_redemption_cut_pct NUMERIC(5,2),
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS product_bill_photos (
  id TEXT PRIMARY KEY,
  product_id TEXT,
  stockist_id TEXT,
  r2_key TEXT,
  public_url TEXT,
  selling_price_at_upload NUMERIC(12,2),
  cost_price_at_upload NUMERIC(12,2),
  file_size_bytes INT,
  content_type TEXT,
  flag_status TEXT,
  flag_reason TEXT,
  flagged_by_admin_id TEXT,
  flagged_at TIMESTAMPTZ,
  uploaded_at TIMESTAMPTZ,
  uploaded_by_stockist_admin_id TEXT
);

CREATE TABLE IF NOT EXISTS partners (
  id TEXT PRIMARY KEY,
  tenant_id TEXT,
  legal_name TEXT,
  display_name TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  address TEXT,
  gst_number TEXT,
  service_types JSONB,
  is_active BOOLEAN DEFAULT true,
  onboarded_at TIMESTAMPTZ,
  onboarded_by_admin_id TEXT,
  promoted_from_lead_id TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS partner_regions (
  id TEXT PRIMARY KEY,
  partner_id TEXT,
  region_id TEXT,
  service_type TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS partner_packages (
  id TEXT PRIMARY KEY,
  partner_id TEXT,
  service_type TEXT,
  name TEXT,
  description TEXT,
  face_value_rupees NUMERIC(12,2),
  cost_to_partner_rupees NUMERIC(12,2),
  point_cost INT,
  active_regions JSONB,
  duration_days INT,
  is_timed BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  price NUMERIC(12,2),
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS partner_users (
  id TEXT PRIMARY KEY,
  partner_id TEXT,
  user_id TEXT,
  role TEXT,
  created_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS customer_partner_bindings (
  id TEXT PRIMARY KEY,
  customer_user_id TEXT,
  cable_partner_id TEXT,
  broadband_partner_id TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS redemption_approvals (
  id TEXT PRIMARY KEY,
  ledger_id TEXT,
  customer_id TEXT,
  customer_user_id TEXT,
  customer_name TEXT,
  partner_id TEXT,
  partner_package_id TEXT,
  face_value_rupees NUMERIC(12,2),
  points_deducted INT,
  points_redeemed INT,
  rupees_value NUMERIC(12,2),
  package_id TEXT,
  package_name TEXT,
  status TEXT,
  admin_notes TEXT,
  partner_notes TEXT,
  rejected_reason TEXT,
  disputed_reason TEXT,
  partner_dispute_reason TEXT,
  admin_id TEXT,
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  fulfilled_at TIMESTAMPTZ,
  partner_fulfilled_at TIMESTAMPTZ,
  disputed_at TIMESTAMPTZ,
  refund_ledger_id TEXT,
  redeemed_at TIMESTAMPTZ,
  next_redemption_allowed_at TIMESTAMPTZ,
  partner_paid BOOLEAN DEFAULT false,
  partner_payout_ref TEXT,
  partner_payout_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS partner_feedback (
  id TEXT PRIMARY KEY,
  partner_id TEXT,
  submitted_by_user_id TEXT,
  linked_type TEXT,
  linked_redemption_approval_id TEXT,
  category TEXT,
  subject TEXT,
  description TEXT,
  status TEXT,
  admin_notes TEXT,
  created_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS partner_notifications (
  id TEXT PRIMARY KEY,
  partner_id TEXT,
  kind TEXT,
  type TEXT,
  title TEXT,
  body TEXT,
  message TEXT,
  is_read BOOLEAN DEFAULT false,
  reference_id TEXT,
  linked_id TEXT,
  created_at TIMESTAMPTZ
);

-- Hot-path Indexes
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_stockist_id ON orders(stockist_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_points_ledger_customer ON points_ledger(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_redemption_approvals_status ON redemption_approvals(status);
CREATE INDEX IF NOT EXISTS idx_redemption_approvals_partner ON redemption_approvals(partner_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_entity ON admin_audit_log(entity_type, entity_id);
