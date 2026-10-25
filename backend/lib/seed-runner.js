const bcrypt = require('bcrypt');

const DEFAULT_DB = {
  tenants: [
    { id: 't1', name: 'Beniffy Cable & Broadband', code: 'fastnet', created_at: new Date().toISOString() }
  ],
  regions: [
    { id: 'r1', tenant_id: 't1', name: 'Kolkata South (Garia)', code: 'kolkata-garia', delivery_fee: 40.0, created_at: new Date().toISOString() },
    { id: 'r2', tenant_id: 't1', name: 'Rural West Bengal (Bishnupur)', code: 'rural-bishnupur', delivery_fee: 30.0, created_at: new Date().toISOString() },
    { id: 'r3', tenant_id: 't1', name: 'Kolkata North (Salt Lake)', code: 'kolkata-saltlake', delivery_fee: null, created_at: new Date().toISOString() }
  ],
  users: [
    { id: 'u-admin', tenant_id: 't1', region_id: 'r1', phone: '9999999999', email: 'admin@fastnet.test', name: 'Super Admin', role: 'ADMIN', kyc_status: 'APPROVED', no_show_count: 0, address: '', created_at: new Date().toISOString(), is_active: true },
    { id: 'u-cust1', tenant_id: 't1', region_id: 'r1', phone: '9876543210', email: 'amit@fastnet.test', name: 'Amit Sen', role: 'CUSTOMER', kyc_status: 'APPROVED', no_show_count: 0, address: '12 Park Street, Garia', created_at: new Date().toISOString(), is_active: true },
    { id: 'u-cust2', tenant_id: 't1', region_id: 'r2', phone: '8765432109', email: 'radha@fastnet.test', name: 'Radha Roy', role: 'CUSTOMER', kyc_status: 'APPROVED', no_show_count: 0, address: '5 Bishnupur Lane', created_at: new Date().toISOString(), is_active: true },
    { id: 'u-stk1', tenant_id: 't1', region_id: 'r1', phone: '7654321098', email: 'madan@fastnet.test', name: 'Madan Shaw', role: 'STOCKIST', kyc_status: 'APPROVED', no_show_count: 0, address: 'Garia Market', created_at: new Date().toISOString(), is_active: true },
    { id: 'u-stk2', tenant_id: 't1', region_id: 'r2', phone: '6543210987', email: 'sarkar@fastnet.test', name: 'Prabhat Sarkar', role: 'STOCKIST', kyc_status: 'APPROVED', no_show_count: 0, address: 'Bishnupur Bazar', created_at: new Date().toISOString(), is_active: true },
    { id: 'u-stk3', tenant_id: 't1', region_id: 'r2', phone: '8432109876', email: 'joy@fastnet.test', name: 'Gopal Joy', role: 'STOCKIST', kyc_status: 'PENDING', no_show_count: 0, kyc_details: JSON.stringify({ id_type: 'Aadhaar', id_number: '1234-5678-9012', shop_name: 'Joy Kirana', shop_address: 'Bishnupur Market Road' }), address: 'Bishnupur Market Road', created_at: new Date().toISOString(), is_active: true },
    { id: 'u-stk5', tenant_id: 't1', region_id: 'r1', phone: '8432109999', email: 'ramesh@fastnet.test', name: 'Ramesh Kumar', role: 'STOCKIST', kyc_status: 'PENDING', no_show_count: 0, kyc_details: JSON.stringify({ id_type: 'Aadhaar', id_number: '9876-5432-1098', shop_name: 'Ramesh Store', shop_address: 'Garia Main Road', document_photo_url: '/api/kyc/documents/sample-aadhaar.jpg' }), address: 'Garia Main Road', created_at: new Date().toISOString(), is_active: true },
    { id: 'u-stk4', tenant_id: 't1', region_id: 'r1', phone: '9432109876', email: 'banerjee@fastnet.test', name: 'Soumik Banerjee', role: 'STOCKIST', kyc_status: 'APPROVED', no_show_count: 0, address: 'Garia Corner', created_at: new Date().toISOString(), is_active: true },
    { id: 'u-stk6', tenant_id: 't1', region_id: 'r2', phone: '8432100001', email: 'ananya@fastnet.test', name: 'Ananya Das', role: 'STOCKIST', kyc_status: 'APPROVED', no_show_count: 0, address: 'Bishnupur Station Road', created_at: new Date().toISOString(), is_active: true },
    { id: 'u-ptr-adhya', tenant_id: 't1', region_id: 'r1', phone: '9876500000', email: 'adhya@partners.example', password_hash: bcrypt.hashSync('partner123', 10), name: 'Adhya Admin', role: 'PARTNER_ADMIN', kyc_status: 'APPROVED', no_show_count: 0, address: '15 Garia Main Road', created_at: '2026-08-01T00:00:00.000Z', is_active: true },
    { id: 'u-ptr-jio', tenant_id: 't1', region_id: 'r1', phone: '9876500001', email: 'jio@partners.example', password_hash: bcrypt.hashSync('partner123', 10), name: 'Jio Admin', role: 'PARTNER_ADMIN', kyc_status: 'APPROVED', no_show_count: 0, address: '8 Park Street', created_at: '2026-08-01T00:00:00.000Z', is_active: true }
  ],
  partners: [
    {
      id: 'ptr-adhya',
      legal_name: 'Adhya Cable Services Pvt Ltd',
      display_name: 'Adhya Cable',
      contact_phone: '9876500000',
      contact_email: 'adhya@partners.example',
      service_types: ['CABLE'],
      payout_upi_id: 'adhya@okaxis',
      payout_account_name: 'Adhya Cable Services Pvt Ltd',
      payout_bank_account: '112233445566',
      payout_bank_ifsc: 'HDFC0001234',
      is_active: true,
      created_at: '2026-08-01T00:00:00.000Z'
    },
    {
      id: 'ptr-jio',
      legal_name: 'JioFiber Local Services',
      display_name: 'JioFiber Local',
      contact_phone: '9876500001',
      contact_email: 'jio@partners.example',
      service_types: ['BROADBAND'],
      payout_upi_id: 'jiofiber@okaxis',
      payout_account_name: 'JioFiber Local Services',
      payout_bank_account: '998877665544',
      payout_bank_ifsc: 'SBIN0001234',
      is_active: true,
      created_at: '2026-08-01T00:00:00.000Z'
    }
  ],
  partner_regions: [
    { id: 'prg-adhya-r1', partner_id: 'ptr-adhya', region_id: 'r1', service_type: 'CABLE', is_active: true, created_at: '2026-08-01T00:00:00.000Z' },
    { id: 'prg-adhya-r2', partner_id: 'ptr-adhya', region_id: 'r2', service_type: 'CABLE', is_active: true, created_at: '2026-08-01T00:00:00.000Z' },
    { id: 'prg-jio-r1', partner_id: 'ptr-jio', region_id: 'r1', service_type: 'BROADBAND', is_active: true, created_at: '2026-08-01T00:00:00.000Z' }
  ],
  partner_packages: [
    {
      id: 'ppk-adhya-basic',
      partner_id: 'ptr-adhya',
      service_type: 'CABLE',
      name: '₹250 Cable Basic Monthly',
      description: 'Basic cable package',
      face_value_rupees: 250,
      cost_to_partner_rupees: 250,
      point_cost: 250,
      active_regions: ['r1'],
      duration_days: null,
      is_timed: false,
      is_active: true,
      price: 250.00,
      created_at: '2026-08-01T00:00:00.000Z'
    },
    {
      id: 'ppk-adhya-premium',
      partner_id: 'ptr-adhya',
      service_type: 'CABLE',
      name: '₹500 Cable Premium Monthly',
      description: 'Premium cable package',
      face_value_rupees: 500,
      cost_to_partner_rupees: 500,
      point_cost: 500,
      active_regions: ['r1'],
      duration_days: 30,
      is_timed: true,
      is_active: true,
      price: 500.00,
      created_at: '2026-08-01T00:00:00.000Z'
    },
    {
      id: 'ppk-jio-basic',
      partner_id: 'ptr-jio',
      service_type: 'BROADBAND',
      name: '₹500 Broadband Basic Monthly',
      description: 'Basic broadband package',
      face_value_rupees: 500,
      cost_to_partner_rupees: 500,
      point_cost: 500,
      active_regions: ['r1'],
      duration_days: 30,
      is_timed: true,
      is_active: true,
      price: 500.00,
      created_at: '2026-08-01T00:00:00.000Z'
    }
  ],
  partner_users: [
    { id: 'pu-adhya', partner_id: 'ptr-adhya', user_id: 'u-ptr-adhya', role: 'OWNER', created_at: '2026-08-01T00:00:00.000Z' },
    { id: 'pu-jio', partner_id: 'ptr-jio', user_id: 'u-ptr-jio', role: 'OWNER', created_at: '2026-08-01T00:00:00.000Z' }
  ],
  customer_partner_bindings: [
    {
      id: 'cpb-cust1',
      customer_user_id: 'u-cust1',
      cable_partner_id: 'ptr-adhya',
      broadband_partner_id: 'ptr-jio',
      updated_at: '2026-08-01T00:00:00.000Z'
    }
  ],
  vendors: [
    { id: 'v1', name: 'Kolkata Wholesale Mart', region_id: 'r1', created_at: new Date().toISOString() },
    { id: 'v2', name: 'Bishnupur Agro Suppliers', region_id: 'r2', created_at: new Date().toISOString() }
  ],
  stockists: [
    {
      id: 's1',
      user_id: 'u-stk1',
      name: 'Madan Grocers',
      region_id: 'r1',
      contact_name: 'Madan Shaw',
      contact_phone: '7654321098',
      vendor_id: 'v1',
      payout_upi_id: '7654321098@okaxis',
      payout_account_name: 'Madan Shaw',
      payout_bank_account: '987654321011',
      payout_ifsc: 'HDFC0001234',
      is_active: true,
      created_at: new Date().toISOString()
    },
    {
      id: 's2',
      user_id: 'u-stk2',
      name: 'Sarkar Daily Store',
      region_id: 'r2',
      contact_name: 'Prabhat Sarkar',
      contact_phone: '6543210987',
      vendor_id: 'v2',
      payout_upi_id: '6543210987@okaxis',
      payout_account_name: 'Prabhat Sarkar',
      payout_bank_account: '987654321022',
      payout_ifsc: 'SBIN0005678',
      is_active: true,
      created_at: new Date().toISOString()
    },
    {
      id: 's3',
      user_id: 'u-stk4',
      name: 'Banerjee Corner Store',
      region_id: 'r1',
      contact_name: 'Soumik Banerjee',
      contact_phone: '9432109876',
      vendor_id: 'v1',
      payout_upi_id: '9432109876@okaxis',
      payout_account_name: 'Soumik Banerjee',
      payout_bank_account: '987654321033',
      payout_ifsc: 'ICIC0001234',
      is_active: true,
      created_at: new Date().toISOString()
    },
    {
      id: 's4',
      user_id: 'u-stk6',
      name: 'Das Variety Stores',
      region_id: 'r2',
      contact_name: 'Ananya Das',
      contact_phone: '8432100001',
      vendor_id: 'v2',
      payout_upi_id: '8432100001@okaxis',
      payout_account_name: 'Ananya Das',
      payout_bank_account: '987654321044',
      payout_ifsc: 'SBIN0001234',
      is_active: true,
      created_at: new Date().toISOString()
    }
  ],
  products: [
    { id: 'p1', tenant_id: 't1', region_id: 'r1', stockist_id: 's1', name: 'Fresh Potatoes (Alu, 1kg)', category: 'groceries', price: 30.0, cost_price: 22.0, description: 'Staple local potatoes', image_url: 'https://images.unsplash.com/photo-1518977676601-b53f82aba655?auto=format&fit=crop&q=80&w=300', latest_bill_photo_id: 'pbp-seed1', created_at: new Date().toISOString() },
    { id: 'p2', tenant_id: 't1', region_id: 'r1', stockist_id: 's1', name: 'Fresh Onions (Piaj, 1kg)', category: 'groceries', price: 45.0, cost_price: 35.0, description: 'Red onions for daily cooking', image_url: 'https://images.unsplash.com/photo-1508747703725-719777637510?auto=format&fit=crop&q=80&w=300', created_at: new Date().toISOString() },
    { id: 'p3', tenant_id: 't1', region_id: 'r1', stockist_id: 's1', name: 'Masoor Dal (500g)', category: 'groceries', price: 60.0, cost_price: 48.0, description: 'Red split lentils', image_url: 'https://images.unsplash.com/photo-1515942400420-2b98fed1f515?auto=format&fit=crop&q=80&w=300', latest_bill_photo_id: 'pbp-seed3', created_at: new Date().toISOString() },
    { id: 'p4', tenant_id: 't1', region_id: 'r1', stockist_id: 's1', name: 'Refined Sugar (1kg)', category: 'groceries', price: 45.0, cost_price: 38.0, description: 'Pure white sugar', image_url: 'https://images.unsplash.com/photo-1622484211148-716598e04141?auto=format&fit=crop&q=80&w=300', created_at: new Date().toISOString() },
    { id: 'p5', tenant_id: 't1', region_id: 'r1', stockist_id: 's1', name: 'Aashirvaad Atta (1kg)', category: 'groceries', price: 55.0, cost_price: 45.0, description: 'Whole wheat flour', image_url: 'https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&q=80&w=300', created_at: new Date().toISOString() },
    { id: 'p6', tenant_id: 't1', region_id: 'r1', stockist_id: 's1', name: 'Amul Butter (100g)', category: 'groceries', price: 58.0, cost_price: 50.0, description: 'Pasteurized salted butter', image_url: 'https://images.unsplash.com/photo-1589985270826-4b7bb135bc9d?auto=format&fit=crop&q=80&w=300', created_at: new Date().toISOString() },
    { id: 'p7', tenant_id: 't1', region_id: 'r1', stockist_id: 's1', name: 'Kachi Ghani Mustard Oil (500ml)', category: 'groceries', price: 90.0, cost_price: 75.0, description: 'Pure cold-pressed mustard oil', image_url: 'https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?auto=format&fit=crop&q=80&w=300', created_at: new Date().toISOString() },
    { id: 'p8', tenant_id: 't1', region_id: 'r1', stockist_id: 's1', name: 'Tata Salt (1kg)', category: 'groceries', price: 28.0, cost_price: 22.0, description: 'Iodized salt', image_url: 'https://images.unsplash.com/photo-1608686207856-001b95cf60ca?auto=format&fit=crop&q=80&w=300', created_at: new Date().toISOString() },
    { id: 'p9', tenant_id: 't1', region_id: 'r1', stockist_id: 's1', name: 'Marie Gold Biscuits (250g)', category: 'groceries', price: 30.0, cost_price: 25.0, description: 'Crunchy tea-time biscuits', image_url: 'https://images.unsplash.com/photo-1558961363-fa8fdf82db35?auto=format&fit=crop&q=80&w=300', created_at: new Date().toISOString() },
    { id: 'p10', tenant_id: 't1', region_id: 'r1', stockist_id: 's1', name: 'Darjeeling Tea (100g)', category: 'groceries', price: 75.0, cost_price: 60.0, description: 'Fragrant Darjeeling tea leaves', image_url: 'https://images.unsplash.com/photo-1594631252845-29fc4589dbd8?auto=format&fit=crop&q=80&w=300', created_at: new Date().toISOString() },

    // Banerjee Corner Store (s3) products in Garia (r1)
    { id: 'p1-s3', tenant_id: 't1', region_id: 'r1', stockist_id: 's3', name: 'Fortune Mustard Oil (1L)', category: 'groceries', price: 140.0, cost_price: 120.0, description: 'Pure mustard oil 1L', image_url: null, created_at: new Date().toISOString() },
    { id: 'p2-s3', tenant_id: 't1', region_id: 'r1', stockist_id: 's3', name: 'Tata Tea Gold (250g)', category: 'groceries', price: 130.0, cost_price: 110.0, description: 'Rich aroma tea 250g', image_url: null, created_at: new Date().toISOString() },
    { id: 'p3-s3', tenant_id: 't1', region_id: 'r1', stockist_id: 's3', name: 'Aashirvaad Shudh Chakki Atta (5kg)', category: 'groceries', price: 245.0, cost_price: 215.0, description: 'Whole wheat flour 5kg', image_url: null, created_at: new Date().toISOString() },
    { id: 'p4-s3', tenant_id: 't1', region_id: 'r1', stockist_id: 's3', name: 'Dettol Original Soap (75g)', category: 'groceries', price: 38.0, cost_price: 30.0, description: 'Germ protection soap', image_url: null, created_at: new Date().toISOString() },
    { id: 'p5-s3', tenant_id: 't1', region_id: 'r1', stockist_id: 's3', name: 'Surf Excel Quick Wash Detergent (1kg)', category: 'groceries', price: 145.0, cost_price: 125.0, description: 'Detergent powder 1kg', image_url: null, created_at: new Date().toISOString() },
    { id: 'p6-s3', tenant_id: 't1', region_id: 'r1', stockist_id: 's3', name: 'Amul Taaza Toned Milk (1L)', category: 'groceries', price: 72.0, cost_price: 62.0, description: 'Toned milk 1L', image_url: null, created_at: new Date().toISOString() },

    // Sarkar Daily Store (s2) products in Bishnupur (r2)
    { id: 'p1-r2', tenant_id: 't1', region_id: 'r2', stockist_id: 's2', name: 'Fresh Potatoes (Alu, 1kg)', category: 'groceries', price: 30.0, cost_price: 22.0, description: 'Staple local potatoes', image_url: 'https://images.unsplash.com/photo-1518977676601-b53f82aba655?auto=format&fit=crop&q=80&w=300', created_at: new Date().toISOString() },
    { id: 'p2-r2', tenant_id: 't1', region_id: 'r2', stockist_id: 's2', name: 'Fresh Onions (Piaj, 1kg)', category: 'groceries', price: 45.0, cost_price: 35.0, description: 'Red onions for daily cooking', image_url: 'https://images.unsplash.com/photo-1508747703725-719777637510?auto=format&fit=crop&q=80&w=300', created_at: new Date().toISOString() },
    { id: 'p3-r2', tenant_id: 't1', region_id: 'r2', stockist_id: 's2', name: 'Masoor Dal (500g)', category: 'groceries', price: 60.0, cost_price: 48.0, description: 'Red split lentils', image_url: 'https://images.unsplash.com/photo-1515942400420-2b98fed1f515?auto=format&fit=crop&q=80&w=300', created_at: new Date().toISOString() },
    { id: 'p4-r2', tenant_id: 't1', region_id: 'r2', stockist_id: 's2', name: 'Refined Sugar (1kg)', category: 'groceries', price: 45.0, cost_price: 38.0, description: 'Pure white sugar', image_url: 'https://images.unsplash.com/photo-1622484211148-716598e04141?auto=format&fit=crop&q=80&w=300', created_at: new Date().toISOString() },
    { id: 'p5-r2', tenant_id: 't1', region_id: 'r2', stockist_id: 's2', name: 'Aashirvaad Atta (1kg)', category: 'groceries', price: 55.0, cost_price: 45.0, description: 'Whole wheat flour', image_url: 'https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&q=80&w=300', created_at: new Date().toISOString() },
    { id: 'p6-r2', tenant_id: 't1', region_id: 'r2', stockist_id: 's2', name: 'Amul Butter (100g)', category: 'groceries', price: 58.0, cost_price: 50.0, description: 'Pasteurized salted butter', image_url: 'https://images.unsplash.com/photo-1589985270826-4b7bb135bc9d?auto=format&fit=crop&q=80&w=300', created_at: new Date().toISOString() },
    { id: 'p7-r2', tenant_id: 't1', region_id: 'r2', stockist_id: 's2', name: 'Kachi Ghani Mustard Oil (500ml)', category: 'groceries', price: 90.0, cost_price: 75.0, description: 'Pure cold-pressed mustard oil', image_url: 'https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?auto=format&fit=crop&q=80&w=300', created_at: new Date().toISOString() },
    { id: 'p8-r2', tenant_id: 't1', region_id: 'r2', stockist_id: 's2', name: 'Tata Salt (1kg)', category: 'groceries', price: 28.0, cost_price: 22.0, description: 'Iodized salt', image_url: 'https://images.unsplash.com/photo-1608686207856-001b95cf60ca?auto=format&fit=crop&q=80&w=300', created_at: new Date().toISOString() },
    { id: 'p9-r2', tenant_id: 't1', region_id: 'r2', stockist_id: 's2', name: 'Marie Gold Biscuits (250g)', category: 'groceries', price: 30.0, cost_price: 25.0, description: 'Crunchy tea-time biscuits', image_url: 'https://images.unsplash.com/photo-1558961363-fa8fdf82db35?auto=format&fit=crop&q=80&w=300', created_at: new Date().toISOString() },

    // Das Variety Stores (s4) products in Bishnupur (r2)
    { id: 'p1-s4', tenant_id: 't1', region_id: 'r2', stockist_id: 's4', name: 'Fortune Soyabean Oil (1L)', category: 'groceries', price: 135.0, cost_price: 115.0, description: 'Refined soyabean oil 1L', image_url: null, created_at: new Date().toISOString() },
    { id: 'p2-s4', tenant_id: 't1', region_id: 'r2', stockist_id: 's4', name: 'Taaza Tea (250g)', category: 'groceries', price: 95.0, cost_price: 80.0, description: 'Green leaf tea 250g', image_url: null, created_at: new Date().toISOString() },
    { id: 'p3-s4', tenant_id: 't1', region_id: 'r2', stockist_id: 's4', name: 'Patanjali Atta (5kg)', category: 'groceries', price: 220.0, cost_price: 195.0, description: 'Chakki fresh wheat atta', image_url: null, created_at: new Date().toISOString() },
    { id: 'p4-s4', tenant_id: 't1', region_id: 'r2', stockist_id: 's4', name: 'Lifebuoy Total Soap (100g)', category: 'groceries', price: 35.0, cost_price: 28.0, description: 'Bath soap 100g', image_url: null, created_at: new Date().toISOString() },
    { id: 'p5-s4', tenant_id: 't1', region_id: 'r2', stockist_id: 's4', name: 'Wheel Washing Powder (1kg)', category: 'groceries', price: 70.0, cost_price: 58.0, description: 'Lemon and jasmine detergent', image_url: null, created_at: new Date().toISOString() }
  ],
  inventory: [
    { id: 'inv-1', stockist_id: 's1', product_id: 'p1', stock_quantity: 50, stock_qty: 50, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-2', stockist_id: 's1', product_id: 'p2', stock_quantity: 60, stock_qty: 60, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-3', stockist_id: 's1', product_id: 'p3', stock_quantity: 40, stock_qty: 40, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-4', stockist_id: 's1', product_id: 'p4', stock_quantity: 100, stock_qty: 100, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-5', stockist_id: 's1', product_id: 'p5', stock_quantity: 80, stock_qty: 80, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-6', stockist_id: 's1', product_id: 'p6', stock_quantity: 30, stock_qty: 30, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-7', stockist_id: 's1', product_id: 'p7', stock_quantity: 45, stock_qty: 45, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-8', stockist_id: 's1', product_id: 'p8', stock_quantity: 90, stock_qty: 90, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-9', stockist_id: 's1', product_id: 'p9', stock_quantity: 110, stock_qty: 110, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-10', stockist_id: 's1', product_id: 'p10', stock_quantity: 35, stock_qty: 35, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-11', stockist_id: 's2', product_id: 'p1-r2', stock_quantity: 25, stock_qty: 25, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-12', stockist_id: 's2', product_id: 'p2-r2', stock_quantity: 30, stock_qty: 30, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-13', stockist_id: 's2', product_id: 'p3-r2', stock_quantity: 20, stock_qty: 20, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-14', stockist_id: 's2', product_id: 'p4-r2', stock_quantity: 50, stock_qty: 50, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-15', stockist_id: 's2', product_id: 'p5-r2', stock_quantity: 40, stock_qty: 40, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-16', stockist_id: 's2', product_id: 'p6-r2', stock_quantity: 15, stock_qty: 15, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-17', stockist_id: 's2', product_id: 'p7-r2', stock_quantity: 20, stock_qty: 20, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-18', stockist_id: 's2', product_id: 'p8-r2', stock_quantity: 45, stock_qty: 45, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-19', stockist_id: 's2', product_id: 'p9-r2', stock_quantity: 60, stock_qty: 60, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-20', stockist_id: 's2', product_id: 'p10-r2', stock_quantity: 18, stock_qty: 18, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-21', stockist_id: 's3', product_id: 'p1-s3', stock_quantity: 40, stock_qty: 40, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-22', stockist_id: 's3', product_id: 'p2-s3', stock_quantity: 35, stock_qty: 35, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-23', stockist_id: 's3', product_id: 'p3-s3', stock_quantity: 20, stock_qty: 20, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-24', stockist_id: 's3', product_id: 'p4-s3', stock_quantity: 60, stock_qty: 60, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-25', stockist_id: 's3', product_id: 'p5-s3', stock_quantity: 30, stock_qty: 30, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-26', stockist_id: 's3', product_id: 'p6-s3', stock_quantity: 50, stock_qty: 50, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-28', stockist_id: 's4', product_id: 'p1-s4', stock_quantity: 30, stock_qty: 30, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-29', stockist_id: 's4', product_id: 'p2-s4', stock_quantity: 40, stock_qty: 40, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-30', stockist_id: 's4', product_id: 'p3-s4', stock_quantity: 25, stock_qty: 25, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-31', stockist_id: 's4', product_id: 'p4-s4', stock_quantity: 50, stock_qty: 50, is_available: true, created_at: new Date().toISOString() },
    { id: 'inv-32', stockist_id: 's4', product_id: 'p5-s4', stock_quantity: 45, stock_qty: 45, is_available: true, created_at: new Date().toISOString() }
  ],
  stockist_inventory: [
    { id: 'sinv-1', stockist_id: 's1', product_id: 'p1', stock_quantity: 50, stock_qty: 50, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-2', stockist_id: 's1', product_id: 'p2', stock_quantity: 60, stock_qty: 60, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-3', stockist_id: 's1', product_id: 'p3', stock_quantity: 40, stock_qty: 40, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-4', stockist_id: 's1', product_id: 'p4', stock_quantity: 100, stock_qty: 100, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-5', stockist_id: 's1', product_id: 'p5', stock_quantity: 80, stock_qty: 80, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-6', stockist_id: 's1', product_id: 'p6', stock_quantity: 30, stock_qty: 30, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-7', stockist_id: 's1', product_id: 'p7', stock_quantity: 45, stock_qty: 45, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-8', stockist_id: 's1', product_id: 'p8', stock_quantity: 90, stock_qty: 90, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-9', stockist_id: 's1', product_id: 'p9', stock_quantity: 110, stock_qty: 110, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-10', stockist_id: 's1', product_id: 'p10', stock_quantity: 35, stock_qty: 35, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-11', stockist_id: 's2', product_id: 'p1-r2', stock_quantity: 25, stock_qty: 25, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-12', stockist_id: 's2', product_id: 'p2-r2', stock_quantity: 30, stock_qty: 30, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-13', stockist_id: 's2', product_id: 'p3-r2', stock_quantity: 20, stock_qty: 20, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-14', stockist_id: 's2', product_id: 'p4-r2', stock_quantity: 50, stock_qty: 50, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-15', stockist_id: 's2', product_id: 'p5-r2', stock_quantity: 40, stock_qty: 40, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-16', stockist_id: 's2', product_id: 'p6-r2', stock_quantity: 15, stock_qty: 15, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-17', stockist_id: 's2', product_id: 'p7-r2', stock_quantity: 20, stock_qty: 20, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-18', stockist_id: 's2', product_id: 'p8-r2', stock_quantity: 45, stock_qty: 45, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-19', stockist_id: 's2', product_id: 'p9-r2', stock_quantity: 60, stock_qty: 60, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-20', stockist_id: 's2', product_id: 'p10-r2', stock_quantity: 18, stock_qty: 18, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-21', stockist_id: 's3', product_id: 'p1-s3', stock_quantity: 40, stock_qty: 40, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-22', stockist_id: 's3', product_id: 'p2-s3', stock_quantity: 35, stock_qty: 35, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-23', stockist_id: 's3', product_id: 'p3-s3', stock_quantity: 20, stock_qty: 20, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-24', stockist_id: 's3', product_id: 'p4-s3', stock_quantity: 60, stock_qty: 60, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-25', stockist_id: 's3', product_id: 'p5-s3', stock_quantity: 30, stock_qty: 30, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-26', stockist_id: 's3', product_id: 'p6-s3', stock_quantity: 50, stock_qty: 50, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-28', stockist_id: 's4', product_id: 'p1-s4', stock_quantity: 30, stock_qty: 30, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-29', stockist_id: 's4', product_id: 'p2-s4', stock_quantity: 40, stock_qty: 40, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-30', stockist_id: 's4', product_id: 'p3-s4', stock_quantity: 25, stock_qty: 25, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-31', stockist_id: 's4', product_id: 'p4-s4', stock_quantity: 50, stock_qty: 50, is_available: true, created_at: new Date().toISOString() },
    { id: 'sinv-32', stockist_id: 's4', product_id: 'p5-s4', stock_quantity: 45, stock_qty: 45, is_available: true, created_at: new Date().toISOString() }
  ],
  orders: [
    {
      id: 'o-seed-conf',
      cart_id: 'cart-seed-1',
      tenant_id: 't1',
      region_id: 'r1',
      customer_id: 'u-cust1',
      stockist_id: 's1',
      stockist_name: 'Madan Grocers',
      status: 'CONFIRMING',
      subtotal: 45.0,
      delivery_fee: 0.0,
      low_order_fee: 0.0,
      total_price: 45.0,
      total_amount: 45.0,
      amount_paid: 45.0,
      fulfillment_type: 'PICKUP',
      pickup_slot: '02:00 PM - 04:00 PM',
      pickup_eta_minutes: 15,
      pickup_pin: '3821',
      payment_status: 'UNPAID',
      payment_method: 'PAY_AT_HANDOVER',
      commission_model: 'profit_v2',
      config_row_id: 'cc-default',
      platform_commission: 3.0,
      points_credited: 2.0,
      stockist_reinvest: 5.0,
      platform_pot: 5.0,
      stockist_payout: 40.0,
      margin: 10.0,
      earn_rate_used: 40.0,
      cancel_deadline: new Date(Date.now() + 50 * 1000).toISOString(),
      no_show_count: 0,
      reschedule_used: false,
      split_released: false,
      items: [
        { productId: 'p2', quantity: 1, price: 45.0, name: 'Fresh Onions (Piaj, 1kg)' }
      ],
      created_at: new Date().toISOString()
    },
    {
      id: 'o-seed-ready',
      cart_id: 'cart-seed-2',
      tenant_id: 't1',
      region_id: 'r1',
      customer_id: 'u-cust1',
      stockist_id: 's1',
      stockist_name: 'Madan Grocers',
      status: 'READY',
      subtotal: 90.0,
      delivery_fee: 0.0,
      low_order_fee: 0.0,
      total_price: 90.0,
      total_amount: 90.0,
      amount_paid: 90.0,
      fulfillment_type: 'PICKUP',
      pickup_slot: '04:00 PM - 06:00 PM',
      pickup_eta_minutes: 0,
      pickup_pin: '7419',
      payment_status: 'UNPAID',
      payment_method: 'PAY_AT_HANDOVER',
      commission_model: 'profit_v2',
      config_row_id: 'cc-default',
      platform_commission: 4.20,
      points_credited: 2.80,
      stockist_reinvest: 7.0,
      platform_pot: 7.0,
      stockist_payout: 83.0,
      margin: 14.0,
      earn_rate_used: 40.0,
      cancel_deadline: new Date(Date.now() - 3600000).toISOString(),
      no_show_count: 0,
      reschedule_used: false,
      split_released: false,
      items: [
        { productId: 'p4', quantity: 2, price: 45.0, name: 'Refined Sugar (1kg)' }
      ],
      created_at: new Date(Date.now() - 1800000).toISOString()
    },
    {
      id: 'o-seed-deliv',
      cart_id: 'cart-seed-3',
      tenant_id: 't1',
      region_id: 'r1',
      customer_id: 'u-cust1',
      stockist_id: 's1',
      stockist_name: 'Madan Grocers',
      status: 'DELIVERED',
      subtotal: 60.0,
      delivery_fee: 0.0,
      low_order_fee: 0.0,
      total_price: 60.0,
      total_amount: 60.0,
      amount_paid: 60.0,
      fulfillment_type: 'PICKUP',
      pickup_slot: '10:00 AM - 12:00 PM',
      pickup_eta_minutes: 0,
      pickup_pin: '1234',
      payment_status: 'PAID',
      payment_method: 'UPI',
      payment_received_method: 'UPI',
      paid_at: new Date(Date.now() - 86400000).toISOString(),
      commission_model: 'profit_v2',
      config_row_id: 'cc-default',
      platform_commission: 4.80,
      points_credited: 3.20,
      stockist_reinvest: 8.0,
      platform_pot: 8.0,
      stockist_payout: 52.0,
      margin: 16.0,
      earn_rate_used: 40.0,
      cancel_deadline: new Date(Date.now() - 86400000).toISOString(),
      no_show_count: 0,
      reschedule_used: false,
      split_released: true,
      razorpay_order_id: 'order_seed_deliv_upi',
      razorpay_payment_id: 'pay_seed_deliv_upi',
      items: [
        { productId: 'p1', quantity: 2, price: 30.0, name: 'Fresh Potatoes (Alu, 1kg)' }
      ],
      created_at: new Date(Date.now() - 86400000).toISOString()
    },
    {
      id: 'o-seed-canc',
      cart_id: 'cart-seed-4',
      tenant_id: 't1',
      region_id: 'r1',
      customer_id: 'u-cust1',
      stockist_id: 's1',
      stockist_name: 'Madan Grocers',
      status: 'CANCELLED',
      subtotal: 55.0,
      delivery_fee: 0.0,
      low_order_fee: 0.0,
      total_price: 55.0,
      total_amount: 55.0,
      amount_paid: 55.0,
      fulfillment_type: 'PICKUP',
      pickup_slot: '12:00 PM - 02:00 PM',
      pickup_eta_minutes: 15,
      pickup_pin: '4455',
      payment_status: 'CANCELLED_UNPAID',
      payment_method: 'PAY_AT_HANDOVER',
      commission_model: 'profit_v2',
      config_row_id: 'cc-default',
      platform_commission: 3.0,
      points_credited: 2.0,
      stockist_reinvest: 5.0,
      platform_pot: 5.0,
      stockist_payout: 50.0,
      margin: 10.0,
      earn_rate_used: 40.0,
      cancel_deadline: new Date(Date.now() - 7200000).toISOString(),
      no_show_count: 0,
      reschedule_used: false,
      split_released: false,
      items: [
        { productId: 'p5', quantity: 1, price: 55.0, name: 'Aashirvaad Atta (1kg)' }
      ],
      created_at: new Date(Date.now() - 7200000).toISOString()
    }
  ],
  order_items: [
    { id: 'oi-seed-conf-1', order_id: 'o-seed-conf', product_id: 'p2', name: 'Fresh Onions (Piaj, 1kg)', product_name: 'Fresh Onions (Piaj, 1kg)', quantity: 1, price: 45.0, cost_price: 35.0, created_at: new Date().toISOString() },
    { id: 'oi-seed-ready-1', order_id: 'o-seed-ready', product_id: 'p4', name: 'Refined Sugar (1kg)', product_name: 'Refined Sugar (1kg)', quantity: 2, price: 45.0, cost_price: 38.0, created_at: new Date(Date.now() - 1800000).toISOString() },
    { id: 'oi-seed-deliv-1', order_id: 'o-seed-deliv', product_id: 'p1', name: 'Fresh Potatoes (Alu, 1kg)', product_name: 'Fresh Potatoes (Alu, 1kg)', quantity: 2, price: 30.0, cost_price: 22.0, created_at: new Date(Date.now() - 86400000).toISOString() },
    { id: 'oi-seed-canc-1', order_id: 'o-seed-canc', product_id: 'p5', name: 'Aashirvaad Atta (1kg)', product_name: 'Aashirvaad Atta (1kg)', quantity: 1, price: 55.0, cost_price: 45.0, created_at: new Date(Date.now() - 7200000).toISOString() }
  ],
  split_payouts: [
    {
      id: 'sp-seed-deliv',
      order_id: 'o-seed-deliv',
      stockist_id: 's1',
      stockist_amount: 52.0,
      platform_amount: 4.80,
      commission_rate_used: 10.0,
      earn_rate_used: 40.0,
      gross_v1_rate_used: null,
      status: 'RELEASED',
      is_paid: true,
      created_at: new Date(Date.now() - 86400000).toISOString()
    }
  ],
  payment_ledger: [
    {
      id: 'plg-seed-conf',
      order_id: 'o-seed-conf',
      event_type: 'PAY_AT_HANDOVER_ORDER_CREATED',
      amount: 45.0,
      metadata: JSON.stringify({ method: 'PAY_AT_HANDOVER', stockist_share: 40.0, platform_share: 3.0, coupon_discount: 0 }),
      created_at: new Date().toISOString()
    },
    {
      id: 'plg-seed-ready',
      order_id: 'o-seed-ready',
      event_type: 'PAY_AT_HANDOVER_ORDER_CREATED',
      amount: 90.0,
      metadata: JSON.stringify({ method: 'PAY_AT_HANDOVER', stockist_share: 83.0, platform_share: 4.20, coupon_discount: 0 }),
      created_at: new Date(Date.now() - 1800000).toISOString()
    },
    {
      id: 'plg-seed-deliv',
      order_id: 'o-seed-deliv',
      event_type: 'HELD',
      amount: 60.0,
      metadata: JSON.stringify({ method: 'UPI', stockist_share: 52.0, platform_share: 4.80, coupon_discount: 0 }),
      created_at: new Date(Date.now() - 86400000).toISOString()
    },
    {
      id: 'plg-seed-deliv-rel',
      order_id: 'o-seed-deliv',
      event_type: 'SPLIT_RELEASED',
      amount: 60.0,
      metadata: JSON.stringify({ stockist_amount: 52.0, platform_amount: 4.80 }),
      created_at: new Date(Date.now() - 86400000).toISOString()
    },
    {
      id: 'plg-seed-canc',
      order_id: 'o-seed-canc',
      event_type: 'ORDER_CANCELLED',
      amount: 55.0,
      metadata: JSON.stringify({ reason: 'Cancelled by customer', method: 'PAY_AT_HANDOVER' }),
      created_at: new Date(Date.now() - 7200000).toISOString()
    }
  ],
  points_ledger: [
    { id: 'l-init1', tenant_id: 't1', region_id: 'r1', customer_id: 'u-cust1', amount: 50.0, type: 'EARN', reference_id: null, order_id: null, description: 'Welcome signup bonus points', created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() },
    { id: 'l-init2', tenant_id: 't1', region_id: 'r2', customer_id: 'u-cust2', amount: 30.0, type: 'EARN', reference_id: null, order_id: null, description: 'Welcome signup bonus points', created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() },
    { id: 'l-seed-deliv', tenant_id: 't1', region_id: 'r1', customer_id: 'u-cust1', amount: 3.20, type: 'EARN', reference_id: null, order_id: 'o-seed-deliv', description: 'Earned from Order #SEED-DELIV at Madan Grocers', created_at: new Date(Date.now() - 86400000).toISOString() }
  ],
  notifications: [
    {
      id: 'notif-seed-1',
      user_id: 'u-stk1',
      type: 'new_order',
      title: 'New order received',
      body: 'New pickup order o-seed-conf received',
      link: 'order:o-seed-conf',
      created_at: new Date().toISOString(),
      read_at: null
    },
    {
      id: 'notif-seed-2',
      user_id: 'u-stk1',
      type: 'bill_approved',
      title: 'Bill approved',
      body: 'Bill for Fresh Potatoes (Alu, 1kg) was approved',
      link: 'product:p1',
      created_at: new Date(Date.now() - 3600000).toISOString(),
      read_at: new Date(Date.now() - 1800000).toISOString()
    }
  ],
  commission_config: [
    {
      id: 'cc-default',
      scope: 'GLOBAL',
      stockist_id: null,
      stockist_reinvest_pct: 50.0,
      points_from_pot_pct: 40.0,
      partner_redemption_cut_pct: 12.0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
  ],
  commission_rates: [
    { id: 'c1', tenant_id: 't1', region_id: 'r1', category: 'groceries', rate_percent: 10.0, created_at: new Date().toISOString() },
    { id: 'c2', tenant_id: 't1', region_id: 'r2', category: 'groceries', rate_percent: 8.0, created_at: new Date().toISOString() }
  ],
  stockist_commission_rates: [
    { id: 'scr1', stockist_id: 's1', rate_percent: 10.0, created_at: new Date().toISOString() },
    { id: 'scr2', stockist_id: 's2', rate_percent: 8.0, created_at: new Date().toISOString() },
    { id: 'scr3', stockist_id: 's3', rate_percent: 10.0, created_at: new Date().toISOString() },
    { id: 'scr4', stockist_id: 's4', rate_percent: 8.0, created_at: new Date().toISOString() }
  ],
  points_earn_config: [
    { id: 'pec1', region_id: 'r1', stockist_id: null, earn_rate_percent: 45.0, created_at: new Date().toISOString() },
    { id: 'pec2', region_id: 'r2', stockist_id: null, earn_rate_percent: 45.0, created_at: new Date().toISOString() }
  ],
  registration_flags: [
    {
      id: 'rf-seed-1',
      user_id: 'u-stk3',
      flag_type: 'DUPLICATE_PHONE',
      severity: 'MEDIUM',
      detail: 'Phone matches another registered account',
      created_at: new Date().toISOString()
    },
    {
      id: 'rf-seed-2',
      user_id: 'u-stk5',
      flag_type: 'SUSPICIOUS_DOCUMENT',
      severity: 'HIGH',
      detail: 'Aadhaar photo quality check required',
      created_at: new Date().toISOString()
    }
  ],
  stockist_vendors: [
    { id: 'sv1', stockist_id: 's1', vendor_id: 'v1', approved_at: new Date().toISOString() },
    { id: 'sv2', stockist_id: 's2', vendor_id: 'v2', approved_at: new Date().toISOString() },
    { id: 'sv3', stockist_id: 's3', vendor_id: 'v1', approved_at: new Date().toISOString() },
    { id: 'sv4', stockist_id: 's4', vendor_id: 'v2', approved_at: new Date().toISOString() }
  ],
  product_bill_photos: [
    {
      id: 'pbp-seed1',
      product_id: 'p1',
      stockist_id: 's1',
      r2_key: 'bills/s1/1785518400112-d6ez17.jpg',
      public_url: 'https://pub-mock.r2.dev/bills/s1/1785518400112-d6ez17.jpg',
      selling_price_at_upload: 30.0,
      cost_price_at_upload: 22.0,
      file_size_bytes: 102400,
      content_type: 'image/jpeg',
      bill_status: 'PENDING',
      rejection_reason: null,
      uploaded_at: '2026-08-01T00:00:00.000Z',
      uploaded_by_stockist_admin_id: 'u-stk1'
    },
    {
      id: 'pbp-seed3',
      product_id: 'p3',
      stockist_id: 's1',
      r2_key: 'bills/s1/1785518400112-d6ez17.jpg',
      public_url: 'https://pub-mock.r2.dev/bills/s1/1785518400112-d6ez17.jpg',
      selling_price_at_upload: 60.0,
      cost_price_at_upload: 48.0,
      file_size_bytes: 102400,
      content_type: 'image/jpeg',
      bill_status: 'REJECTED',
      rejection_reason: 'Supplier invoice details blurry and missing GSTIN',
      uploaded_at: '2026-08-01T00:00:00.000Z',
      uploaded_by_stockist_admin_id: 'u-stk1'
    }
  ]
};

async function seedDatabase(db) {
  // Ordered insertion respecting FKs
  const tableOrder = [
    'tenants',
    'regions',
    'vendors',
    'users',
    'partners',
    'partner_regions',
    'partner_packages',
    'partner_users',
    'customer_partner_bindings',
    'stockists',
    'products',
    'product_bill_photos',
    'inventory',
    'stockist_inventory',
    'commission_config',
    'commission_rates',
    'stockist_commission_rates',
    'points_earn_config',
    'stockist_vendors',
    'registration_flags',
    'orders',
    'order_items',
    'split_payouts',
    'payment_ledger',
    'points_ledger',
    'notifications'
  ];

  for (const tableName of tableOrder) {
    const rows = DEFAULT_DB[tableName] || [];
    for (const row of rows) {
      await db.insertRow(tableName, row);
    }
  }
}

module.exports = {
  DEFAULT_DB,
  seedDatabase
};
