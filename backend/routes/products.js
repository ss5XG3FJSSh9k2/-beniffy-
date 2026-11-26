
const db = require('../db');
const cfg = require('../config');
const r2 = require('../lib/r2');
const { requireAuth } = require('../lib/authz');
const { getCallerStockist, assertOwnsStockist } = require('../lib/access');
const { generateId } = require('../lib/misc');
const { appendAudit , createNotification } = require('../lib/audit');
const { uploadBillMiddleware, signBillRow } = require('../lib/bills');

const { getCustomerVisibleProducts } = require('../services/stockists');
const { getCommissionConfig } = require('../services/orders');

function registerPreAdminProductRoutes(app) {
app.get('/api/products', async (req, res) => {
  const { regionId, stockistId } = req.query;
  const products = await db.getTable('products');
  const inventory = await db.getTable('stockist_inventory');

  let filtered;
  if (req.query.customer === 'true' && stockistId) {
    const stockists = await db.getTable('stockists');
    const stockist = stockists.find(s => s.id === stockistId);
    if (regionId && (!stockist || stockist.region_id !== regionId)) {
      filtered = [];
    } else {
      filtered = getCustomerVisibleProducts(stockist || stockistId, products);
    }
  } else {
    filtered = products.filter(p => !p.deleted_at);
    if (req.query.customer === 'true') {
      filtered = filtered.filter(p => p.is_sellable !== false);
    }
    if (regionId) {
      filtered = filtered.filter(p => p.region_id === regionId);
    }
    if (stockistId) {
      filtered = filtered.filter(p => p.stockist_id === stockistId);
    }
  }

  if (stockistId) {
    const billPhotos = await db.getTable('product_bill_photos');
    filtered = filtered.map(p => {
      const inv = inventory.find(i => i.stockist_id === stockistId && i.product_id === p.id);
      let rejectionReason = null;
      if (p.is_sellable === false) {
        const rejectedBill = billPhotos.find(b => b.product_id === p.id && b.bill_status === 'REJECTED');
        if (rejectedBill) rejectionReason = rejectedBill.rejection_reason;
      }
      return {
        ...p,
        stock_qty: inv ? inv.stock_qty : 0,
        is_available: inv ? inv.is_available : false,
        rejection_reason: rejectionReason
      };
    });
  }

  filtered = await Promise.all(filtered.map(async p => {
    let estimated_points = null;
    if (p.cost_price !== undefined && p.cost_price !== null) {
      const margin = Math.max(0, p.price - p.cost_price);
      if (margin > 0) {
        const cfg = await getCommissionConfig(p.stockist_id);
        const reinvestPct = parseFloat(cfg?.stockist_reinvest_pct) || 50;
        const pointsPct = parseFloat(cfg?.points_from_pot_pct) || 40;
        const platformPot = margin - (margin * reinvestPct / 100);
        estimated_points = Math.round(platformPot * (pointsPct / 100) * 100) / 100;
      } else {
        estimated_points = 0;
      }
    }
    return {
      ...p,
      estimated_points
    };
  }));

  const isAdmin = req.user && req.user.role === 'ADMIN';
  let callerStockist = null;
  if (req.user && req.user.role === 'STOCKIST') {
    callerStockist = await getCallerStockist(req);
  }

  const result = filtered.map(p => {
    const isOwnShop = Boolean(callerStockist && callerStockist.id === p.stockist_id);
    const canSeeFullFields = (isAdmin || isOwnShop) && req.query.customer !== 'true';

    if (canSeeFullFields) {
      return p;
    }

    return {
      id: p.id,
      name: p.name,
      category: p.category,
      price: p.price,
      description: p.description !== undefined ? p.description : '',
      image_url: p.image_url !== undefined ? p.image_url : null,
      stock_qty: p.stock_qty !== undefined ? p.stock_qty : 0,
      is_available: p.is_available !== undefined ? p.is_available : false,
      estimated_points: p.estimated_points,
      stockist_id: p.stockist_id,
      region_id: p.region_id
    };
  });

  return res.json(result);
});

const handleCreateProductRoute = async (req, res) => {
  if (req.headers['x-r2-mock'] === 'false' || !r2.isR2Configured()) {
    return res.status(503).json({ error: 'r2_not_configured', message: 'Bill upload service unavailable' });
  }

  const name = String(req.body.name || '').trim();
  if (name.length < 2 || name.length > cfg.PRODUCT_NAME_MAX_LENGTH) {
    return res.status(400).json({ error: 'validation_failed', message: 'Invalid name', fields: { name: `non-empty max ${cfg.PRODUCT_NAME_MAX_LENGTH}` } });
  }

  const billUrl = req.body.bill_invoice_url || req.body.bill_photo_url || req.body.billPhotoUrl || req.body.bill_photo;

  // If content-type is JSON or no req.file present and no billUrl:
  if (!req.file && !billUrl) {
    return res.status(400).json({
      error: 'bill_photo_required',
      message: "New SKUs require a bill photo. Send as multipart/form-data with a 'bill_photo' file field."
    });
  }

  // Validate file MIME if file present
  if (req.file) {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedMimeTypes.includes(req.file.mimetype)) {
      return res.status(400).json({
        error: 'invalid_file_type',
        message: 'Only JPG, PNG, and WebP bill photos are allowed.'
      });
    }

    // Validate file size (8MB)
    if (req.file.size > 8 * 1024 * 1024) {
      return res.status(400).json({
        error: 'file_too_large',
        message: 'Bill photo exceeds 8 MB limit.'
      });
    }
  }

  const price = req.body.price !== undefined ? req.body.price : req.body.selling_price;
  const costPrice = req.body.costPrice !== undefined ? req.body.costPrice : req.body.cost_price;
  const category = req.body.category || 'groceries';
  const initialStock = req.body.initialStock !== undefined ? req.body.initialStock : (req.body.stock_qty !== undefined ? req.body.stock_qty : req.body.initial_stock);
  const callerStockist = await getCallerStockist(req);
  const stockistId = (callerStockist && callerStockist.id) || req.body.stockistId || req.body.stockist_id;
  if (!stockistId) {
    return res.status(400).json({ error: 'Choose a stockist.', message: 'Stockist is required.' });
  }
  const stockistsTable = await db.getTable('stockists');
  const targetStockist = stockistsTable.find(s => s.id === stockistId);
  if (!targetStockist) {
    return res.status(400).json({ error: 'Stockist record not found', message: 'Stockist record does not exist.' });
  }
  if (!await assertOwnsStockist(req, res, stockistId)) return;
  const regionId = req.body.regionId || req.body.region_id || (targetStockist && targetStockist.region_id) || (req.user && req.user.region_id);
  if (!regionId) {
    return res.status(400).json({ error: 'Choose a region.', message: 'Choose a region.' });
  }
  const regionsTable = await db.getTable('regions');
  if (!regionsTable.some(r => r.id === regionId)) {
    return res.status(400).json({ error: 'Invalid region', message: 'Region does not exist.' });
  }
  const description = req.body.description;
  const imageUrl = req.body.image_url;

  if (price === undefined || initialStock === undefined) {
    return res.status(400).json({ error: 'Missing product fields' });
  }

  const parsedPrice = Number(price);
  const parsedCostPrice = costPrice !== undefined ? Number(costPrice) : parsedPrice * 0.75;
  if (!Number.isFinite(parsedPrice) || parsedPrice <= 0 || parsedPrice > cfg.PRODUCT_PRICE_MAX_RUPEES) {
    return res.status(400).json({ error: 'validation_failed', message: 'Invalid price', fields: { price: `must be > 0 and <= ${cfg.PRODUCT_PRICE_MAX_RUPEES}` } });
  }
  if (!Number.isFinite(parsedCostPrice) || parsedCostPrice < 0 || parsedCostPrice > parsedPrice) {
    return res.status(400).json({ error: 'validation_failed', message: 'Invalid cost price', fields: { costPrice: 'must be >= 0 and <= price' } });
  }
  const initialStockNum = parseInt(initialStock, 10);
  if (!Number.isInteger(initialStockNum) || initialStockNum < 0 || initialStockNum > cfg.PRODUCT_STOCK_MAX) {
    return res.status(400).json({ error: 'validation_failed', message: 'Invalid stock', fields: { stock: `integer >= 0 and <= ${cfg.PRODUCT_STOCK_MAX}` } });
  }

  // Upload bill to R2
  let uploadRes = { key: 'mock-bill-key', publicUrl: billUrl || 'http://localhost/mock-bill.jpg' };
  if (req.file) {
    try {
      uploadRes = await r2.uploadBillPhoto(req.file.buffer, req.file.mimetype, `bills/${stockistId}`);
    } catch (uploadErr) {
      return res.status(500).json({ error: 'upload_failed', message: uploadErr.message });
    }
  }

  const commissionRates = await db.getTable('commission_rates');
  const catConfig = commissionRates.find(c => c.category === category);
  const marginThreshold = catConfig && catConfig.margin_threshold_percent !== undefined ? parseFloat(catConfig.margin_threshold_percent) : 50.00;
  const marginPct = parsedPrice > 0 ? ((parsedPrice - parsedCostPrice) / parsedPrice) * 100 : 0;
  const stockists = await db.getTable('stockists');
  const stockist = stockists.find(s => s.id === stockistId);
  const streak = stockist ? (stockist.verified_bill_streak || 0) : 0;
  let billStatus = (streak >= 5 && marginPct <= marginThreshold) ? 'VERIFIED' : 'PENDING';

  const billPhotos = await db.getTable('product_bill_photos');
  const billPhotoId = 'pbp-' + generateId();
  const productId = 'p-' + generateId();

  const billPhotoRow = {
    id: billPhotoId,
    product_id: productId,
    stockist_id: stockistId,
    r2_key: uploadRes.key,
    public_url: (r2.isR2Configured() && !r2.isMockMode()) ? uploadRes.publicUrl : `/api/bills/${uploadRes.key}`,
    selling_price_at_upload: parsedPrice,
    cost_price_at_upload: parsedCostPrice,
    file_size_bytes: req.file ? req.file.size : 0,
    content_type: req.file ? req.file.mimetype : 'image/jpeg',
    bill_status: billStatus,
    uploaded_at: new Date().toISOString(),
    uploaded_by_stockist_admin_id: req.body.uploaded_by || stockistId
  };

  billPhotos.push(billPhotoRow);
  await db.saveTable('product_bill_photos', billPhotos);

  let finalImageUrl = imageUrl;
  if (req.files) {
    const imgFile = (req.files['imageFile'] && req.files['imageFile'][0]) ||
                    (req.files['image'] && req.files['image'][0]) ||
                    (req.files['image_file'] && req.files['image_file'][0]);
    if (imgFile) {
      try {
        const imgUploadRes = await r2.uploadBillPhoto(imgFile.buffer, imgFile.mimetype, `product-images/${stockistId}`);
        finalImageUrl = `/api/images/${imgUploadRes.key}`;
      } catch (uploadErr) {
        console.error('Failed to upload product image file:', uploadErr);
      }
    }
  }

  const products = await db.getTable('products');
  const newProduct = {
    id: productId,
    tenant_id: 't1',
    region_id: stockist ? stockist.region_id : regionId,
    stockist_id: stockistId,
    name,
    category,
    price: parsedPrice,
    cost_price: parsedCostPrice,
    description: description !== undefined ? description : (name + ' added by local stockist'),
    image_url: finalImageUrl || null,
    latest_bill_photo_id: billPhotoId,
    created_at: new Date().toISOString()
  };

  products.push(newProduct);
  await db.saveTable('products', products);

  const inventory = await db.getTable('stockist_inventory');
  inventory.push({
    id: 'sinv-' + generateId(),
    stockist_id: stockistId,
    product_id: productId,
    stock_qty: parseInt(initialStock, 10),
    stock_quantity: parseInt(initialStock, 10),
    is_available: parseInt(initialStock, 10) > 0,
    created_at: new Date().toISOString()
  });
  await db.saveTable('stockist_inventory', inventory);
  
  newProduct.stock_qty = parseInt(initialStock, 10);
  newProduct.is_available = parseInt(initialStock, 10) > 0;

  return res.json({ success: true, product_id: productId, product: newProduct, bill_photo: signBillRow(billPhotoRow) });
};

app.post('/api/products', requireAuth, uploadBillMiddleware, handleCreateProductRoute);
app.post('/api/stockist/products', requireAuth, uploadBillMiddleware, handleCreateProductRoute);

app.delete('/api/products/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const products = await db.getTable('products');
  const user = req.user;
  
  const product = products.find(p => p.id === id);
  if (!product) {
    return res.status(404).json({ error: 'product_not_found', message: 'Product not found' });
  }

  let isOwner = false;
  let isAdmin = user.role === 'ADMIN';

  if (user.role === 'STOCKIST') {
    const myShop = await getCallerStockist(req);
    if (myShop && myShop.id === product.stockist_id) {
      isOwner = true;
    }
  }

  if (!isOwner && !isAdmin) {
    return res.status(403).json({ error: 'forbidden', message: 'You do not own this product' });
  }

  if (product.deleted_at) {
    return res.status(200).json({ message: 'Already deleted' });
  }

  const inventory = await db.getTable('stockist_inventory');
  const inv = inventory.find(i => i.product_id === product.id && i.stockist_id === product.stockist_id);
  const stockQty = inv ? inv.stock_qty : 0;

  await db.updateRow('products', product.id, { deleted_at: new Date().toISOString(), is_sellable: false });
  if (inv) {
    await db.updateRow('stockist_inventory', inv.id, { is_available: false });
  }

  await appendAudit(req, 'DELETE_PRODUCT', 'product', product.id,
    { name: product.name, shop_id: product.stockist_id, stock_qty: stockQty },
    null, '');

  return res.status(200).json({ message: 'Product deleted successfully' });
});

app.patch('/api/products/:id', requireAuth, uploadBillMiddleware, async (req, res) => {
  const { id } = req.params;
  const stockistId = req.body.stockistId || req.body.stockist_id;
  if (stockistId && !await assertOwnsStockist(req, res, stockistId)) return;

  if (!stockistId) {
    return res.status(400).json({ error: 'Missing stockistId' });
  }
  if (!await assertOwnsStockist(req, res, stockistId)) return;

  // Ownership check
  const inventory = await db.getTable('stockist_inventory');
  const inv = inventory.find(i => i.product_id === id && i.stockist_id === stockistId);
  if (!inv) {
    return res.status(403).json({ error: 'Not the owning stockist' });
  }

  const products = await db.getTable('products');
  const product = products.find(p => p.id === id);
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }

  const reqPrice = req.body.price;
  const reqCostPrice = req.body.costPrice !== undefined ? req.body.costPrice : req.body.cost_price;

  const newPrice = reqPrice !== undefined ? parseFloat(reqPrice) : product.price;
  const newCostPrice = reqCostPrice !== undefined ? parseFloat(reqCostPrice) : product.cost_price;

  if (newPrice <= 0) {
    return res.status(400).json({ error: 'Price must be greater than 0' });
  }
  if (newCostPrice < 0 || newCostPrice > newPrice) {
    return res.status(400).json({ error: 'Cost price must be between 0 and selling price' });
  }

  const priceChanged = Math.abs(newPrice - product.price) > 0.001 || Math.abs(newCostPrice - product.cost_price) > 0.001;

  if (priceChanged && !req.file) {
    return res.status(400).json({
      error: 'bill_required_for_price_change',
      message: 'Price change detected. A new bill photo is required.'
    });
  }

  let billPhotoRow = null;
  if (req.file) {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedMimeTypes.includes(req.file.mimetype)) {
      return res.status(400).json({
        error: 'invalid_file_type',
        message: 'Only JPG, PNG, and WebP bill photos are allowed.'
      });
    }
    if (req.file.size > 8 * 1024 * 1024) {
      return res.status(400).json({
        error: 'file_too_large',
        message: 'Bill photo exceeds 8 MB limit.'
      });
    }

    if (!r2.isR2Configured()) {
      return res.status(503).json({ error: 'r2_not_configured', message: 'Bill upload service unavailable' });
    }

    let uploadRes;
    try {
      uploadRes = await r2.uploadBillPhoto(req.file.buffer, req.file.mimetype, `bills/${stockistId}`);
    } catch (uploadErr) {
      return res.status(500).json({ error: 'upload_failed', message: uploadErr.message });
    }

    const prodCategory = req.body.category !== undefined ? req.body.category : product.category;
    const commissionRates = await db.getTable('commission_rates');
    const catConfig = commissionRates.find(c => c.category === prodCategory);
    const marginThreshold = catConfig && catConfig.margin_threshold_percent !== undefined ? parseFloat(catConfig.margin_threshold_percent) : 50.00;
    const marginPct = newPrice > 0 ? ((newPrice - newCostPrice) / newPrice) * 100 : 0;

    const stockists = await db.getTable('stockists');
    const stockist = stockists.find(s => s.id === stockistId);
    const streak = stockist ? (stockist.verified_bill_streak || 0) : 0;
    let billStatus = (streak >= 5 && marginPct <= marginThreshold) ? 'VERIFIED' : 'PENDING';

    const billPhotos = await db.getTable('product_bill_photos');
    billPhotoRow = {
      id: 'pbp-' + generateId(),
      product_id: id,
      stockist_id: stockistId,
      r2_key: uploadRes.key,
      public_url: (r2.isR2Configured() && !r2.isMockMode()) ? uploadRes.publicUrl : `/api/bills/${uploadRes.key}`,
      selling_price_at_upload: newPrice,
      cost_price_at_upload: newCostPrice,
      file_size_bytes: req.file.size,
      content_type: req.file.mimetype,
      bill_status: billStatus,
      uploaded_at: new Date().toISOString(),
      uploaded_by_stockist_admin_id: req.body.uploaded_by || stockistId
    };

    billPhotos.push(billPhotoRow);
    await db.saveTable('product_bill_photos', billPhotos);

    product.latest_bill_photo_id = billPhotoRow.id;
    product.is_sellable = true; // Restores sellability when new bill is uploaded
  }

  if (req.body.name !== undefined) product.name = req.body.name;
  if (req.body.description !== undefined) product.description = req.body.description;
  if (req.body.category !== undefined) product.category = req.body.category;
  if (req.body.image_url !== undefined) product.image_url = req.body.image_url;
  if (req.files) {
    const imgFile = (req.files['imageFile'] && req.files['imageFile'][0]) ||
                    (req.files['image'] && req.files['image'][0]) ||
                    (req.files['image_file'] && req.files['image_file'][0]);
    if (imgFile) {
      try {
        const imgUploadRes = await r2.uploadBillPhoto(imgFile.buffer, imgFile.mimetype, `product-images/${stockistId}`);
        product.image_url = `/api/images/${imgUploadRes.key}`;
      } catch (uploadErr) {
        console.error('Failed to upload product image file on edit:', uploadErr);
      }
    }
  }

  product.price = newPrice;
  product.cost_price = newCostPrice;

  if (req.body.stock_qty !== undefined || req.body.stock_quantity !== undefined) {
    const rawStock = req.body.stock_qty !== undefined ? req.body.stock_qty : req.body.stock_quantity;
    const newStock = parseInt(rawStock, 10);
    const prevStock = inv.stock_qty;
    inv.stock_qty = newStock;
    inv.stock_quantity = newStock;
    inv.is_available = newStock > 0;
    await db.updateRow('stockist_inventory', inv.id, inv);
    if (prevStock > 0 && newStock <= 0) {
      try {
        const stockists = await db.getTable('stockists');
        const stk = stockists.find(s => s.id === stockistId);
        if (stk && stk.user_id) {
          await createNotification({
            userId: stk.user_id,
            type: 'product_out_of_stock',
            title: 'Product out of stock',
            body: `${product.name} is out of stock`,
            link: `product:${product.id}`
          });
        }
      } catch (notifErr) {
        console.error('[notification] Failed to create out_of_stock notification on product update:', notifErr);
      }
    }
  }

  await db.saveTable('products', products);

  return res.json({ success: true, product, bill_photo: billPhotoRow ? signBillRow(billPhotoRow) : undefined });
});

// GET /api/products/:id/bill-history
app.get('/api/products/:id/bill-history', requireAuth, async (req, res) => {
  const { id } = req.params;
  const products = await db.getTable('products');
  const product = products.find(p => p.id === id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  if (!await assertOwnsStockist(req, res, product.stockist_id)) return;
  const billPhotos = await db.getTable('product_bill_photos');
  const history = billPhotos
    .filter(b => b.product_id === id)
    .sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at));
  return res.json(history.map(signBillRow));
});
}

function registerPostAdminProductRoutes(app) {
app.get('/api/products/search-alternatives', async (req, res) => {
  const { name, regionId, excludeStockistId } = req.query;
  if (!name || !regionId) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const products = await db.getTable('products');
  const inventory = await db.getTable('stockist_inventory');
  const stockists = await db.getTable('stockists');

  const similarProducts = products.filter(p => !p.deleted_at && p.region_id === regionId && p.name.toLowerCase().includes(name.toLowerCase()));

  const alternatives = [];
  similarProducts.forEach(p => {
    const invList = inventory.filter(i => i.product_id === p.id && i.stock_qty > 0 && i.stockist_id !== excludeStockistId);
    invList.forEach(inv => {
      const stockist = stockists.find(s => s.id === inv.stockist_id && s.is_active);
      if (stockist) {
        alternatives.push({ shopId: stockist.id, shopName: stockist.name, stockQty: inv.stock_qty, price: p.price });
      }
    });
  });

  return res.json(alternatives);
});
}

module.exports = { registerPreAdminProductRoutes, registerPostAdminProductRoutes };
