const {
  dbModule, loginAs, clearLogin, post, del, assert
} = require('../lib/harness.js');

module.exports = async function section(_ctx) {
  console.log('\n--- Section 23: Product Delete Audit (DELETE /api/products/:id) ---');

  await post('http://localhost:3001/api/admin/reset-db', {});

  // Create two products for Madan Grocers (u-stk1 / 7654321098, s1)
  loginAs('u-stk1', 'STOCKIST');
  const createRes1 = await post('http://localhost:3001/api/products', {
    name: 'Audit Delete Product 1',
    price: 50,
    costPrice: 40,
    initialStock: 10,
    stockistId: 's1',
    category: 'groceries'
  });
  assert(createRes1.status === 200 && createRes1.body.product_id, 'Stockist creates first product for delete audit test');
  const prodId1 = createRes1.body.product_id;

  const createRes2 = await post('http://localhost:3001/api/products', {
    name: 'Audit Delete Product 2',
    price: 60,
    costPrice: 45,
    initialStock: 5,
    stockistId: 's1',
    category: 'groceries'
  });
  assert(createRes2.status === 200 && createRes2.body.product_id, 'Stockist creates second product for delete audit test');
  const prodId2 = createRes2.body.product_id;

  // 1. Stockist 7654321098 (Madan Grocers) deletes its own product
  const auditBefore1 = ((await dbModule.getTable('admin_audit_log')) || []).filter(a => a.action === 'DELETE_PRODUCT' && a.entity_id === prodId1).length;
  assert(auditBefore1 === 0, 'No DELETE_PRODUCT audit row exists before delete');

  const delRes1 = await del(`http://localhost:3001/api/products/${prodId1}`);
  assert(delRes1.status === 200 && delRes1.body.message === 'Product deleted successfully', 'Stockist deleting own product returns 200');

  const productsAfter1 = await dbModule.getTable('products');
  const deletedProd1 = productsAfter1.find(p => p.id === prodId1);
  assert(deletedProd1 && Boolean(deletedProd1.deleted_at) && deletedProd1.is_sellable === false, 'Deleted product has deleted_at set and is_sellable false');

  const invAfter1 = await dbModule.getTable('stockist_inventory');
  const deletedInv1 = invAfter1.find(i => i.product_id === prodId1 && i.stockist_id === 's1');
  assert(deletedInv1 && deletedInv1.is_available === false, 'Deleted product inventory has is_available false');

  const auditRows1 = ((await dbModule.getTable('admin_audit_log')) || []).filter(a => a.action === 'DELETE_PRODUCT' && a.entity_type === 'product' && a.entity_id === prodId1);
  assert(auditRows1.length === 1 && auditRows1[0].before?.name === 'Audit Delete Product 1' && auditRows1[0].after === null, 'admin_audit_log has 1 DELETE_PRODUCT row for product');

  // 2. Deleting the same product again returns 200 "Already deleted", no second audit row
  const delAgainRes = await del(`http://localhost:3001/api/products/${prodId1}`);
  assert(delAgainRes.status === 200 && delAgainRes.body.message === 'Already deleted', 'Deleting same product again returns 200 Already deleted');

  const auditRowsAfterAgain = ((await dbModule.getTable('admin_audit_log')) || []).filter(a => a.action === 'DELETE_PRODUCT' && a.entity_id === prodId1);
  assert(auditRowsAfterAgain.length === 1, 'No second audit row written on repeat delete');

  // 3. Another stockist (u-stk2 / 6543210987) deleting that shop's product returns 403, nothing changed, no audit row
  loginAs('u-stk2', 'STOCKIST');
  const otherDelRes = await del(`http://localhost:3001/api/products/${prodId2}`);
  assert(otherDelRes.status === 403, 'Another stockist deleting s1 product returns 403');

  const prod2AfterForbidden = (await dbModule.getTable('products')).find(p => p.id === prodId2);
  assert(prod2AfterForbidden && !prod2AfterForbidden.deleted_at && prod2AfterForbidden.is_sellable !== false, 'Forbidden delete leaves product unchanged');

  const auditRowsForbidden = ((await dbModule.getTable('admin_audit_log')) || []).filter(a => a.action === 'DELETE_PRODUCT' && a.entity_id === prodId2);
  assert(auditRowsForbidden.length === 0, 'Forbidden delete writes no audit row');

  // 4. Admin deletes a product -> 200 + audit row with admin_user_id = 'u-admin'
  loginAs('u-admin', 'ADMIN');
  const adminDelRes = await del(`http://localhost:3001/api/products/${prodId2}`);
  assert(adminDelRes.status === 200 && adminDelRes.body.message === 'Product deleted successfully', 'Admin deleting product returns 200');

  const auditRowsAdmin = ((await dbModule.getTable('admin_audit_log')) || []).filter(a => a.action === 'DELETE_PRODUCT' && a.entity_type === 'product' && a.entity_id === prodId2);
  assert(auditRowsAdmin.length === 1 && auditRowsAdmin[0].admin_user_id === 'u-admin', 'Admin delete writes audit row with admin_user_id = u-admin');

  clearLogin();
};
