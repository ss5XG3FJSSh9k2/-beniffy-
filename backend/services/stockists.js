
const db = require('../db');
const { generateId } = require('../lib/misc');

function getCustomerVisibleProducts(stockist, products) {
  if (!stockist || !Array.isArray(products)) return [];
  const stockistId = typeof stockist === 'object' && stockist !== null ? stockist.id : stockist;
  return products.filter(p =>
    p.stockist_id === stockistId &&
    !p.deleted_at &&
    p.is_active !== false &&
    p.is_sellable !== false
  );
}

function calculateIsShopOpen(stockist, currentTimeStr) {
  if (stockist.manual_closed) {
    if (!stockist.closed_until || new Date() < new Date(stockist.closed_until)) {
      return false; // Manually closed and either indefinitely or until a future time
    }
  }

  if (!stockist.opening_time || !stockist.closing_time) return true;
  let closing = stockist.closing_time;
  if (closing === '24:00') closing = '23:59';
  const opening = stockist.opening_time;

  let currentTime = currentTimeStr;
  if (!currentTime) {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(Date.now() + IST_OFFSET_MS);
    currentTime = istNow.getUTCHours().toString().padStart(2, '0') + ':' + 
                  istNow.getUTCMinutes().toString().padStart(2, '0');
  }

  if (closing <= opening) {
    return currentTime >= opening || currentTime < closing;
  }
  return currentTime >= opening && currentTime < closing;
}

function findStockistOwner(stockist, users) {
  if (!stockist || !Array.isArray(users)) return null;
  if (stockist.user_id) {
    return users.find(u => u.id === stockist.user_id && u.kyc_status !== 'RELEASED') || null;
  }
  const sPhone = (stockist.contact_phone || stockist.phone || '').trim();
  if (!sPhone) return null;
  return users.find(u => u.role === 'STOCKIST' && u.kyc_status !== 'RELEASED' && typeof u.phone === 'string' && u.phone.trim() !== '' && u.phone.trim() === sPhone) || null;
}

function getCustomerVisibility(stockist, users, products) {
  if (!stockist || stockist.is_active === false) {
    return { visible: false, reason: 'inactive' };
  }
  const owner = findStockistOwner(stockist, users);
  if (!owner) {
    return { visible: false, reason: 'KYC pending' };
  }
  if (owner.is_active === false) {
    return { visible: false, reason: 'owner deactivated' };
  }
  if (owner.kyc_status !== 'APPROVED') {
    return { visible: false, reason: 'KYC pending' };
  }
  if (products && Array.isArray(products)) {
    const shopProducts = getCustomerVisibleProducts(stockist, products);
    if (shopProducts.length === 0) {
      return { visible: false, reason: 'no products' };
    }
  }
  return { visible: true, reason: null };
}

const isCustomerVisible = (stockist, users, products) => {
  return getCustomerVisibility(stockist, users, products).visible;
};

async function setMainWholesaler(stockistId, vendorId) {
  const stockists = await db.getTable('stockists');
  const stockist = stockists.find(s => s.id === stockistId);
  if (!stockist) return null;

  stockist.vendor_id = vendorId;
  await db.saveTable('stockists', stockists);

  if (vendorId) {
    const stockistVendors = await db.getTable('stockist_vendors');
    if (!stockistVendors.some(sv => sv.stockist_id === stockistId && sv.vendor_id === vendorId)) {
      stockistVendors.push({
        id: 'sv-' + generateId(),
        stockist_id: stockistId,
        vendor_id: vendorId,
        approved_at: new Date().toISOString()
      });
      await db.saveTable('stockist_vendors', stockistVendors);
    }
  }

  return stockist;
}

function getRegionDeliveryFee(regionRow) {
  if (!regionRow || regionRow.delivery_fee === null || regionRow.delivery_fee === undefined) return null;
  const val = parseFloat(regionRow.delivery_fee);
  if (isNaN(val) || !isFinite(val) || val < 0) return null;
  return val;
}


// PATCH /api/stockist/profile - Stockist self-editable settings (TESTER-47)
async function resolveStockistRate(stockistId) {
  const rates = await db.getTable('stockist_commission_rates');
  const stkRates = rates.filter(r => r.stockist_id === stockistId);
  return stkRates.length > 0 ? stkRates[stkRates.length - 1].rate_percent : 10.0;
}

function publicStockist(s) {
  if (!s) return null;
  return {
    id: s.id,
    name: s.name,
    region_id: s.region_id,
    opening_time: s.opening_time !== undefined ? s.opening_time : '09:00',
    closing_time: s.closing_time !== undefined ? s.closing_time : '21:00',
    is_shop_open: s.is_shop_open !== undefined ? s.is_shop_open : calculateIsShopOpen(s),
    manual_closed: Boolean(s.manual_closed),
    closed_until: s.closed_until || null,
    delivery_radius_km: s.delivery_radius_km !== undefined ? s.delivery_radius_km : 5,
    min_order_value: s.min_order_value !== undefined ? s.min_order_value : 0,
    prep_eta_minutes: s.prep_eta_minutes !== undefined ? s.prep_eta_minutes : 15,
    product_count: s.product_count !== undefined ? s.product_count : 0,
    rating: s.rating !== undefined ? s.rating : null,
    ratings_count: s.ratings_count !== undefined ? s.ratings_count : 0,
    reliabilityBadge: s.reliabilityBadge || 'Active Partner'
  };
}

async function getAvailablePartnersForRegion(regionId) {
  if (!regionId) return { cable: [], broadband: [] };

  const partners = await db.getTable('partners');
  const partnerRegions = await db.getTable('partner_regions');

  const activePartnersMap = new Map(
    partners.filter(p => p.is_active !== false).map(p => [p.id, p])
  );

  const cableSet = new Map();
  const broadbandSet = new Map();

  const matchingRegions = partnerRegions.filter(
    pr => pr.region_id === regionId && pr.is_active !== false && activePartnersMap.has(pr.partner_id)
  );

  for (const pr of matchingRegions) {
    const ptr = activePartnersMap.get(pr.partner_id);
    if (!ptr) continue;
    const sanitized = {
      id: ptr.id,
      display_name: ptr.display_name,
      service_types: ptr.service_types || []
    };

    if (pr.service_type === 'CABLE' && !cableSet.has(ptr.id)) {
      cableSet.set(ptr.id, sanitized);
    } else if (pr.service_type === 'BROADBAND' && !broadbandSet.has(ptr.id)) {
      broadbandSet.set(ptr.id, sanitized);
    }
  }

  return {
    cable: Array.from(cableSet.values()),
    broadband: Array.from(broadbandSet.values())
  };
}

module.exports = {
  getCustomerVisibleProducts,
  calculateIsShopOpen,
  findStockistOwner,
  getCustomerVisibility,
  isCustomerVisible,
  setMainWholesaler,
  getRegionDeliveryFee,
  resolveStockistRate,
  publicStockist,
  getAvailablePartnersForRegion
};
