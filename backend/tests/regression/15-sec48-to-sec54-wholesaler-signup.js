const {
  fs, path, dbModule, loginAs, clearLogin, post, get, del, assert
} = require('../lib/harness.js');

module.exports = async function section(_ctx) {
  // --- Section 48: BF-WHOLESALER-SYNC-AND-MAIN: Shop Wholesaler One Source of Truth ---
  console.log('\n--- Section 48: BF-WHOLESALER-SYNC-AND-MAIN: Shop Wholesaler One Source of Truth ---');

  loginAs('u-admin', 'ADMIN');

  // (c) Admin create with no wholesaler is rejected
  // 1. Missing vendor_id -> 400
  const createNoVendorRes = await post('http://localhost:3001/api/admin/stockists', {
    name: 'Reject Shop No Vendor',
    phone: '9876543210',
    region_id: 'r1'
  });
  assert(createNoVendorRes.status === 400 && createNoVendorRes.body.error === 'Wholesaler is required', 'Admin create stockist with no wholesaler returns 400');

  // 2. Non-existent vendor_id -> 400
  const createBadVendorRes = await post('http://localhost:3001/api/admin/stockists', {
    name: 'Reject Shop Bad Vendor',
    phone: '9876543211',
    region_id: 'r1',
    vendor_id: 'v-nonexistent'
  });
  assert(createBadVendorRes.status === 400 && createBadVendorRes.body.error === 'Selected wholesaler does not exist', 'Admin create stockist with non-existent wholesaler returns 400');

  // 3. vendor_id in different region -> 400 (v2 is in r2, shop in r1)
  const createDiffRegionRes = await post('http://localhost:3001/api/admin/stockists', {
    name: 'Reject Shop Diff Region',
    phone: '9876543212',
    region_id: 'r1',
    vendor_id: 'v2'
  });
  assert(createDiffRegionRes.status === 400 && createDiffRegionRes.body.error === 'Selected wholesaler is in a different region', 'Admin create stockist with cross-region wholesaler returns 400');

  // (a) Edit a shop from wholesaler A to B: B's count and list both show it, A's don't, and restock from B succeeds
  // Create Wholesaler A and B in region r1
  const createVendorARes = await post('http://localhost:3001/api/admin/vendors', { name: 'Wholesaler A Test', regionId: 'r1' });
  assert(createVendorARes.status === 200, 'Created Wholesaler A');
  const vendorAId = createVendorARes.body.vendor.id;

  const createVendorBRes = await post('http://localhost:3001/api/admin/vendors', { name: 'Wholesaler B Test', regionId: 'r1' });
  assert(createVendorBRes.status === 200, 'Created Wholesaler B');
  const vendorBId = createVendorBRes.body.vendor.id;

  // Create test shop under Wholesaler A
  const testShopPhone = '9811122233';
  const createShopRes = await post('http://localhost:3001/api/admin/stockists', {
    name: 'Saha Variety Sync Test',
    phone: testShopPhone,
    region_id: 'r1',
    vendor_id: vendorAId
  });
  assert(createShopRes.status === 200, 'Created test shop under Wholesaler A');
  const testShopId = createShopRes.body.stockist.id;

  // Verify Wholesaler A has test shop and B does not
  let vList = await get('http://localhost:3001/api/admin/vendors');
  let vA = vList.body.find(v => v.id === vendorAId);
  let vB = vList.body.find(v => v.id === vendorBId);
  assert(vA && vA.approved_count === 1 && vA.approved_stockists.some(s => s.id === testShopId && s.is_main), 'Wholesaler A has shop in approved_stockists with is_main=true');
  assert(vB && vB.approved_count === 0, 'Wholesaler B has 0 approved stockists initially');

  // Now edit shop from Wholesaler A to B (keep_old_vendor = false)
  const editShopRes = await post(`http://localhost:3001/api/admin/stockists/${testShopId}`, {
    name: 'Saha Variety Sync Test',
    region_id: 'r1',
    vendor_id: vendorBId,
    keep_old_vendor: false
  });
  assert(editShopRes.status === 200, 'Edited test shop to Wholesaler B without keeping old wholesaler');

  // Verify: B's count and list both show it with is_main=true; A's count and list don't
  vList = await get('http://localhost:3001/api/admin/vendors');
  vA = vList.body.find(v => v.id === vendorAId);
  vB = vList.body.find(v => v.id === vendorBId);
  assert(vB && vB.approved_count === 1 && vB.approved_stockists.some(s => s.id === testShopId && s.is_main), "Wholesaler B count=1 and list shows shop with is_main=true");
  assert(vA && vA.approved_count === 0 && !vA.approved_stockists.some(s => s.id === testShopId), "Wholesaler A count=0 and list does not show shop");

  // Verify restocking from B succeeds, and restocking from A fails
  // Find user for this stockist
  const stkOwnerUsers = await get('http://localhost:3001/api/admin/customers');
  const shopOwner = stkOwnerUsers.body.find(u => u.phone === testShopPhone) || { id: 'u-admin', role: 'ADMIN' };
  loginAs(shopOwner.id, shopOwner.role || 'STOCKIST');

  const restockBRes = await post('http://localhost:3001/api/stockists/restock', {
    stockistId: testShopId,
    vendorId: vendorBId,
    items: [{ productId: 'p1', quantity: 5 }]
  });
  assert(restockBRes.status === 200, 'Restock from Wholesaler B succeeds');

  const restockARes = await post('http://localhost:3001/api/stockists/restock', {
    stockistId: testShopId,
    vendorId: vendorAId,
    items: [{ productId: 'p1', quantity: 5 }]
  });
  assert(restockARes.status === 400 && restockARes.body.error === 'Selected wholesaler is not approved for this store.', 'Restock from Wholesaler A fails with not approved error');

  // (b) Approve Association on a shop with no main sets it as main
  loginAs('u-admin', 'ADMIN');
  // Clear shop's vendor_id in db
  const dbInst = require('../../db.js');
  const curStockists = await dbInst.getTable('stockists');
  const targetStk = curStockists.find(s => s.id === testShopId);
  if (targetStk) {
    targetStk.vendor_id = null;
    await dbInst.saveTable('stockists', curStockists);
  }

  // Also remove stockist_vendors links for this shop
  let curSV = await dbInst.getTable('stockist_vendors');
  curSV = curSV.filter(sv => sv.stockist_id !== testShopId);
  await dbInst.saveTable('stockist_vendors', curSV);

  // Call POST /api/admin/stockist-vendors
  const approveAssocRes = await post('http://localhost:3001/api/admin/stockist-vendors', {
    stockistId: testShopId,
    vendorId: vendorAId
  });
  assert(approveAssocRes.status === 200, 'POST /api/admin/stockist-vendors succeeds');

  // Check that the shop now has vendorAId as its main wholesaler
  const reloadedStockists = await dbInst.getTable('stockists');
  const updatedShop = reloadedStockists.find(s => s.id === testShopId);
  assert(updatedShop && updatedShop.vendor_id === vendorAId, 'Approve Association on shop with no main sets it as main wholesaler');

  // (d) For every wholesaler, load count == approved_count
  const syncVendorsRes = await get('http://localhost:3001/api/admin/vendors');
  const syncVendors = syncVendorsRes.body;
  const regionsInTest = Array.from(new Set(syncVendors.map(v => v.region_id).filter(Boolean)));

  let allLoadCountsMatch = true;
  for (const rId of regionsInTest) {
    const loadRes = await get(`http://localhost:3001/api/admin/vendors/load?region_id=${rId}`);
    if (loadRes.status === 200 && Array.isArray(loadRes.body)) {
      for (const lv of loadRes.body) {
        const vMatch = syncVendors.find(v => v.id === lv.id);
        if (vMatch && vMatch.approved_count !== lv.stockist_count) {
          allLoadCountsMatch = false;
        }
      }
    }
  }
  assert(allLoadCountsMatch === true, 'For every wholesaler, load count == approved_count');

  // --- Section 49: Remove fake camera notch from phone app screens ---
  console.log('\n--- Section 49: Remove fake camera notch from phone app screens ---');
  const notchIndexCss = fs.readFileSync(path.join(__dirname, '../../../frontend/src/index.css'), 'utf8');
  const notchAppJsx = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');

  assert(!notchIndexCss.includes('.phone-notch'), 'index.css does not contain .phone-notch CSS rule');
  assert(!notchAppJsx.includes('className="phone-notch"'), 'App.jsx does not contain phone-notch elements');
  const phoneScreenRule = notchIndexCss.match(/\.phone-screen\s*\{[^}]*\}/s);
  assert(phoneScreenRule && phoneScreenRule[0].includes('padding-top: 16px') && !phoneScreenRule[0].includes('padding-top: 36px') && !phoneScreenRule[0].includes('padding-top: 10px'), '.phone-screen has single padding-top: 16px rule with legacy and notch offsets removed');

  // --- Section 50: Email never lands in sign-up phone field; Bengali phone label ---
  console.log('\n--- Section 50: Email never lands in sign-up phone field; Bengali phone label ---');
  const s50App = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  const s50NormSrc = (s50App.match(/const normalizeFrontendPhone = \(val\) => \{[\s\S]*?\n\};/) || [''])[0];
  const s50Norm = s50NormSrc ? new Function(`${s50NormSrc}; return normalizeFrontendPhone;`)() : () => null;
  assert(s50Norm('tapas.kundu@beniffy.test') === '', 'normalizeFrontendPhone: email -> empty string');
  assert(s50Norm('919831000001') === '9831000001' && s50Norm('+91 98310 00001') === '9831000001', 'normalizeFrontendPhone: drops leading 91 on 12 digits');
  assert(s50Norm('98310000012345') === '9831000001', 'normalizeFrontendPhone: max 10 digits');
  const s50PhoneInput = (s50App.match(/const PhoneInput = [\s\S]*?\n\};/) || [''])[0];
  assert(/normalizeFrontendPhone\(value\)/.test(s50PhoneInput) && s50PhoneInput.includes('value={sanitizedValue}'), 'PhoneInput sanitizes its value prop before rendering');
  assert(!s50App.includes('{loginPhone ? `: ${loginPhone}` : \'\'}') && (s50App.match(/\{signupIdentifierValue \? `: \$\{signupIdentifierValue\}` : ''\}/g) || []).length === 2 && /const signupIdentifierValue = signupIdentifierType === 'email' \? regEmail : \(\/\^\\d\{10\}\$\/\.test\(regPhone\) \? regPhone : ''\);/.test(s50App), 'Sign-up banners show the phone only when it is exactly 10 digits');
  const s50Open = (s50App.match(/const openSignupFromLogin = \(role\) => \{[\s\S]*?\n  \};/) || [''])[0];
  assert(/raw\.includes\('@'\)[\s\S]*setRegEmail\(raw\.toLowerCase\(\)\);\s*setRegPhone\(''\)/.test(s50Open), 'Opening sign-up with an email puts it in Email and leaves phone empty');
  assert((s50App.match(/onClick[=:] ?\{?handleOpen(Customer|Stockist)Signup/g) || []).length === 4, 'All four sign-up entry points use the shared login->sign-up helper');
  assert(!s50App.includes('\u092b\u094b\u0928 \u09a8\u09ae\u09cd\u09ac\u09b0') && (s50App.match(/'\u09ab\u09cb\u09a8 \u09a8\u09ae\u09cd\u09ac\u09b0 \(\u09e7\u09e6 \u09b8\u0982\u0996\u09cd\u09af\u09be\)'/g) || []).length >= 3, 'Bengali phone label is fully Bengali at every sign-up form');
  const s50Deva = /[\u0900-\u0963\u0966-\u097F]/; // Devanagari letters; shared danda U+0964/5 excluded
  const s50Beng = /[\u0980-\u09FF]/;
  const s50Mixed = [];
  s50App.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(/'(?:[^'\\`]|\\.)*'|"(?:[^"\\`]|\\.)*"/g)) if (s50Beng.test(m[0]) && s50Deva.test(m[0])) s50Mixed.push(`${i + 1}: ${m[0]}`);
    for (const m of line.matchAll(/`(?:[^`\\]|\\.)*`/g)) {
      let s = m[0], prev;
      do { prev = s; s = s.replace(/\$\{[^{}]*\}/g, ''); } while (s !== prev);
      if (s50Beng.test(s) && s50Deva.test(s)) s50Mixed.push(`${i + 1}: ${m[0]}`);
    }
  });
  if (s50Mixed.length) console.log('  Mixed-script literals:\n  ' + s50Mixed.join('\n  '));
  assert(s50Mixed.length === 0, 'No string literal in App.jsx mixes Bengali and Devanagari letters');

  // --- Section 51: Sign-up puts the login email or phone in its own field; both required ---
  console.log('\n--- Section 51: Sign-up puts the login email or phone in its own field; both required ---');
  // Run the real openSignupFromLogin against stub setters.
  const s51RunOpen = (loginValue) => {
    const st = {};
    const set = (k) => (v) => { st[k] = v; };
    const body = s50Open.replace(/^const openSignupFromLogin = /, 'return ');
    const fn = new Function('loginPhone', 'normalizeFrontendPhone', 'setOtpSent', 'setLoginOtp', 'setRegPhoneError', 'setSignupIdentifierType', 'setRegEmail', 'setRegPhone', 'setShowCustomerSignup', 'setShowStockistSignup', 'setSignupShowMissing', body)(
      loginValue, s50Norm, set('otpSent'), set('loginOtp'), set('regPhoneError'), set('type'), set('regEmail'), set('regPhone'), set('customer'), set('stockist'), set('showMissing'));
    fn('customer');
    return st;
  };
  const s51Email = s51RunOpen('  Tapas.Kundu@Beniffy.test ');
  assert(s51Email.type === 'email' && s51Email.regEmail === 'tapas.kundu@beniffy.test' && s51Email.regPhone === '', 'Sign-up from an email login: type=email, regEmail trimmed+lowercased, regPhone empty');
  const s51Phone = s51RunOpen('+91 98310 00001');
  assert(s51Phone.type === 'phone' && s51Phone.regPhone === '9831000001' && s51Phone.regEmail === '', 'Sign-up from a phone login: type=phone, regPhone normalized, regEmail empty');
  const s51Junk = s51RunOpen('abc');
  assert(s51Junk.type === 'phone' && s51Junk.regPhone === '', 'Sign-up from an invalid login value: phone-first with empty phone');
  const s51Cust = (s50App.match(/const handleCustomerRegister = async \(\) => \{[\s\S]*?\n  \};/) || [''])[0];
  const s51Stk = (s50App.match(/const handleStockistRegister = async \(\) => \{[\s\S]*?\n  \};/) || [''])[0];
  assert(s51Cust && s51Stk && !s51Cust.includes('loginPhone') && !s51Stk.includes('loginPhone'), 'Register handlers never read loginPhone');
  assert(s51Cust.includes('phone: regPhone, email: regEmail') && s51Stk.includes("formData.append('phone', regPhone)") && s51Stk.includes("formData.append('email', regEmail)"), 'Register handlers send regPhone and regEmail');
  // Order: double-tap guard, missing-field check, then the phone format check.
  const s51Head = (src) => src.split('\n').slice(1, 4).map(l => l.trim()).join(' | ');
  const s51Order = (src, missingFn) => s51Head(src) === `if (signupSubmitting) return; | if (flagMissingSignupFields(${missingFn}())) return; | if (!validateSignupPhone()) return;`;
  assert(s51Order(s51Cust, 'customerSignupMissing') && s51Order(s51Stk, 'stockistSignupMissing'), 'Both handlers validate the sign-up phone first (after the missing-field check)');
  const s51Validate = (s50App.match(/const validateSignupPhone = \(\) => \{[\s\S]*?\n  \};/) || [''])[0];
  assert(s51Validate.includes('/^[6-9]\\d{9}$/.test(regPhone)') && s51Validate.includes('setRegPhoneError(') && s51Validate.includes("document.getElementById('signup-phone-input')?.focus()"), 'Invalid sign-up phone sets the field error and focuses the phone field');
  assert((s50App.match(/\{signupIdentifierType === 'email' \? renderSignupEmailField\(\) : renderSignupPhoneField\(\)\}/g) || []).length === 2 && (s50App.match(/\{signupIdentifierType === 'email' \? renderSignupPhoneField\(\) : renderSignupEmailField\(\)\}/g) || []).length === 2, 'Customer and stockist forms render the login identifier first and the other in the lower slot');
  const s51PhoneField = (s50App.match(/const renderSignupPhoneField = \(\) => \([\s\S]*?\n    \);/) || [''])[0];
  const s51EmailField = (s50App.match(/const renderSignupEmailField = \(\) => \([\s\S]*?\n    \);/) || [''])[0];
  assert(/\brequired\b/.test(s51PhoneField) && /\brequired\b/.test(s51EmailField) && s51PhoneField.includes('value={regPhone}') && s51EmailField.includes('value={regEmail}') && s51PhoneField.includes('<FieldError error={regPhoneError} />'), 'Both sign-up identifier fields are required and bound to their own state');

  // --- Section 52: Sign-up buttons always tappable; empty fields named, not silently blocked ---
  console.log('\n--- Section 52: Sign-up buttons always tappable; empty fields named, not silently blocked ---');
  const s52Btn = (id) => (s50App.match(new RegExp(`<button \\s*\\n\\s*id="${id}"[\\s\\S]*?</button>`)) || [''])[0];
  const s52StkBtn = s52Btn('signup-stockist-submit-btn');
  const s52CustBtn = s52Btn('signup-customer-submit-btn');
  assert(s52StkBtn.includes('disabled={signupSubmitting}') && (s52StkBtn.match(/disabled=/g) || []).length === 1 && s52StkBtn.includes('onClick={handleStockistRegister}'), 'Submit for KYC Review is disabled only while the request is in flight');
  assert(s52CustBtn.includes('disabled={signupSubmitting}') && (s52CustBtn.match(/disabled=/g) || []).length === 1 && s52CustBtn.includes('onClick={handleCustomerRegister}') && !s52CustBtn.includes('opacity'), 'Create Account is disabled only while the request is in flight');
  assert(!s50App.includes('!regName || !regShopName || !regAddress || !regRegion || !regDocPhoto') && !s50App.includes('disabled={regions.length === 0 || !customerTermsAgreed}'), 'Old disabled-until-filled conditions are gone');
  assert(s52StkBtn.includes("signupSubmitLabel(t('Submit for KYC Review'") && s52CustBtn.includes("signupSubmitLabel(t('Create Account'") && s50App.includes("t('Submitting…', 'सबमिट हो रहा है…', 'জমা দেওয়া হচ্ছে…')"), 'Both buttons show "Submitting…" while in flight');
  const s52Flag = (s50App.match(/const flagMissingSignupFields = \(missing\) => \{[\s\S]*?\n  \};/) || [''])[0];
  assert(s52Flag.includes("showToast(t('Fill all the details to confirm.', 'पुष्टि करने के लिए सभी विवरण भरें।', 'নিশ্চিত করতে সব তথ্য পূরণ করুন।'), 'error')") && s52Flag.includes('scrollIntoView') && s52Flag.includes('.focus('), 'Missing fields: one error toast, scroll to and focus the first');
  // Run the real missing-field lists against stub state.
  const s52Fn = (name) => (s50App.match(new RegExp(`const ${name} = \\(\\) => \\[[\\s\\S]*?\\]\\.filter\\(Boolean\\);`)) || [''])[0].replace(new RegExp(`^const ${name} = `), 'return ');
  const s52Vars = ['regName', 'regPhone', 'regEmail', 'regShopName', 'regRegion', 'regKycType2', 'aadhaarDigits', 'regKycNumber2', 'regDocPhoto', 'regAddress', 'noCableProvider', 'signupCablePartnerId', 'hasBroadbandAnswered', 'hasBroadband', 'noBroadbandProvider', 'signupBroadbandPartnerId', 'customerTermsAgreed'];
  const s52Run = (name, st) => new Function(...s52Vars, s52Fn(name))(...s52Vars.map(v => st[v]))();
  const s52Empty = { regName: '', regPhone: '', regEmail: '', regShopName: '', regRegion: '', regKycType2: 'Aadhaar', aadhaarDigits: '', regKycNumber2: '', regDocPhoto: null, regAddress: '', noCableProvider: false, signupCablePartnerId: '', hasBroadbandAnswered: false, hasBroadband: false, noBroadbandProvider: false, signupBroadbandPartnerId: '', customerTermsAgreed: false };
  const s52Full = { ...s52Empty, regName: 'A', regPhone: '9831000001', regEmail: 'a@b.test', regShopName: 'S', regRegion: 'r1', aadhaarDigits: '234567890123', regDocPhoto: {}, regAddress: 'X', noCableProvider: true, hasBroadbandAnswered: true, customerTermsAgreed: true };
  assert(JSON.stringify(s52Run('stockistSignupMissing', s52Empty)) === JSON.stringify(['name', 'phone', 'email', 'shopName', 'region', 'idNumber', 'docPhoto', 'address']) && JSON.stringify(s52Run('stockistSignupMissing', s52Full)) === '[]', 'Stockist missing list covers every required field; empty when filled');
  assert(JSON.stringify(s52Run('stockistSignupMissing', { ...s52Full, regDocPhoto: null })) === '["docPhoto"]' && JSON.stringify(s52Run('stockistSignupMissing', { ...s52Full, regKycType2: 'Voter ID', regKycNumber2: '' })) === '["idNumber"]', 'Stockist: only Document Photo / non-Aadhaar ID reported when that alone is empty');
  assert(JSON.stringify(s52Run('customerSignupMissing', s52Empty)) === JSON.stringify(['phone', 'email', 'name', 'region', 'cable', 'broadband', 'terms']) && JSON.stringify(s52Run('customerSignupMissing', s52Full)) === '[]' && JSON.stringify(s52Run('customerSignupMissing', { ...s52Full, hasBroadband: true })) === '["broadbandProvider"]', 'Customer missing list covers every required field; provider required only after Yes');
  const s52Ids = (s50App.match(/const SIGNUP_FIELD_IDS = \{[\s\S]*?\};/) || [''])[0];
  const s52IdPairs = [...s52Ids.matchAll(/(\w+): '([\w-]+)'/g)].map(m => [m[1], m[2]]);
  assert(s52IdPairs.length === 13 && s52IdPairs.every(([, id]) => s50App.includes(`id="${id}"`)), 'Every sign-up field id used for scroll/focus exists in the markup');
  assert(s52IdPairs.every(([k]) => s50App.includes(`renderMissing('${k}')`)), 'Every required sign-up field renders its Required line');
  assert(s50App.includes("const missingBorder = (key) => (signupMissing.includes(key) ? { borderColor: 'var(--danger-text)' } : undefined);") && s50App.includes("t('Required', 'आवश्यक', 'আবশ্যক')"), 'Missing fields get a --danger-text border and a translated Required line');
  assert(/\} finally \{ setSignupSubmitting\(false\); \}\s*\n  \};$/.test(s51Cust) && /\} finally \{ setSignupSubmitting\(false\); \}\s*\n  \};$/.test(s51Stk), 'Submitting state always resets after the request');
  const s52StkHead = s51Stk.indexOf('flagMissingSignupFields');
  assert(s52StkHead > 0 && s52StkHead < s51Stk.indexOf('Aadhaar must be exactly 12 digits') && s52StkHead < s51Stk.indexOf('validateKycId(') && s51Stk.indexOf('validateKycId(') < s51Stk.indexOf('setSignupSubmitting(true)'), 'Stockist format checks run only after every field is filled, before sending');

  // --- Section 53: Remove stray Open a Shop button inside shop sign-up form ---
  console.log('\n--- Section 53: Remove stray Open a Shop button inside shop sign-up form ---');
  const s53StockistForm = (s50App.match(/\/\* Stockist Sign Up Flow \*\/[\s\S]*?id="signup-stockist-submit-btn"[\s\S]*?<\/button>\s*<\/div>\s*<\/>/) || [''])[0];
  const s53CustomerForm = (s50App.match(/\/\* Customer Sign Up Flow \*\/[\s\S]*?id="signup-customer-submit-btn"[\s\S]*?<\/button>\s*<\/div>\s*<\/div>\s*<\/>/) || [''])[0];
  assert(s53StockistForm && !s53StockistForm.includes('renderStockistSignupBtn') && !s53StockistForm.includes('renderCustomerSignupBtn'), 'Stockist sign-up form contains no stray signup buttons');
  assert(s53CustomerForm && !s53CustomerForm.includes('renderStockistSignupBtn') && !s53CustomerForm.includes('renderCustomerSignupBtn'), 'Customer sign-up form contains no stray signup buttons');
  assert((s50App.match(/renderStockistSignupBtn\(\)/g) || []).length === 2, 'renderStockistSignupBtn is invoked exactly twice (login screen and OTP screen)');
  assert((s50App.match(/renderCustomerSignupBtn\(\)/g) || []).length === 2, 'renderCustomerSignupBtn is invoked exactly twice (login screen and OTP screen)');

  // --- Section 54: Removing an account frees its phone and email; no false KYC pending ---
  console.log('\n--- Section 54: Removing an account frees its phone and email; no false KYC pending ---');

  // Test 1: Fresh stockist (0 real activity) -> blacklist -> remove -> hard DELETED
  clearLogin();
  const s54FreshPhone = '9733000001';
  const s54FreshEmail = 'stk_fresh_973301@test.com';
  const s54FreshId = '234567890128';

  const s54RegFreshRes = await post('http://localhost:3001/api/auth/register-stockist', {
    name: 'Fresh Stockist One',
    phone: s54FreshPhone,
    email: s54FreshEmail,
    shop_name: 'Fresh Shop One',
    address: 'Shop 1 Address, Town',
    region_id: 'r1',
    id_type: 'Aadhaar',
    id_number: s54FreshId
  }, {
    asMultipart: true,
    fileObj: { fieldName: 'documentPhoto', filename: 'doc1.jpg', mime: 'image/jpeg', buffer: Buffer.from('mock photo') }
  });
  assert(s54RegFreshRes.status === 200 && s54RegFreshRes.body.success, 'Stockist 9733000001 registers successfully');
  const s54FreshUserId = s54RegFreshRes.body.user.id;

  // Admin blacklists it
  loginAs('u-admin', 'ADMIN');
  const s54BlRes = await post(`http://localhost:3001/api/admin/users/${s54FreshUserId}/blacklist`, {
    reason: 'Suspicious documents'
  });
  assert(s54BlRes.status === 200 && s54BlRes.body.status === 'BLACKLISTED', 'Admin blacklists stockist 9733000001');

  // Check references: admin_audit_log, user_blacklist, registration_flags, stockists NOT counted
  const s54FreshRefsRes = await get(`http://localhost:3001/api/admin/users/${s54FreshUserId}/references`);
  assert(s54FreshRefsRes.status === 200 && s54FreshRefsRes.body.reference_count === 0, 'References check reports 0 real references for fresh blacklisted stockist');

  // Admin removes the account
  const s54FreshDelRes = await del(`http://localhost:3001/api/admin/users/${s54FreshUserId}/account`);
  assert(s54FreshDelRes.status === 200 && s54FreshDelRes.body.action === 'DELETED', 'Remove account for fresh stockist results in DELETED action');

  // Verify user and stockist rows deleted
  const s54AllUsersAfterDel = await dbModule.getTable('users');
  assert(!s54AllUsersAfterDel.some(u => u.id === s54FreshUserId), 'User row hard deleted from users table');
  const s54AllStockistsAfterDel = await dbModule.getTable('stockists');
  assert(!s54AllStockistsAfterDel.some(s => s.user_id === s54FreshUserId), 'Stockist row deleted from stockists table');

  // (a) send-otp for that phone returns no-account response (404)
  clearLogin();
  const s54FreshSendOtpRes = await post('http://localhost:3001/api/stockist/auth/send-otp', {
    phone: s54FreshPhone
  });
  assert(s54FreshSendOtpRes.status === 404 && s54FreshSendOtpRes.body.error === 'No account found', 'send-otp for removed phone returns 404 No account found');

  const s54FreshVerifyRes = await post('http://localhost:3001/api/auth/verify-otp', {
    phone: s54FreshPhone,
    otp: '123456',
    expected_role: 'STOCKIST'
  });
  assert(s54FreshVerifyRes.status === 404 && s54FreshVerifyRes.body.error === 'No account found', 'verify-otp for removed phone returns 404 No account found');

  // (b) register again with the same phone and email succeeds with kyc_status PENDING
  const s54ReRegFreshRes = await post('http://localhost:3001/api/auth/register-stockist', {
    name: 'Fresh Stockist One Reborn',
    phone: s54FreshPhone,
    email: s54FreshEmail,
    shop_name: 'Fresh Shop One Reborn',
    address: 'Shop 1 Reborn Address, Town',
    region_id: 'r1',
    id_type: 'Aadhaar',
    id_number: '234567890139'
  }, {
    asMultipart: true,
    fileObj: { fieldName: 'documentPhoto', filename: 'doc1_re.jpg', mime: 'image/jpeg', buffer: Buffer.from('mock photo') }
  });
  assert(s54ReRegFreshRes.status === 200 && s54ReRegFreshRes.body.user?.kyc_status === 'PENDING', 'Re-registering with same phone and email succeeds with kyc_status PENDING');

  // (d) admin_audit_log still has BLACKLIST_USER and DELETE_ACCOUNT rows
  loginAs('u-admin', 'ADMIN');
  const s54AuditRes = await get('http://localhost:3001/api/admin/audit-log');
  const s54AuditEntries = s54AuditRes.body || [];
  const s54HasBlAudit = s54AuditEntries.some(a => a.action === 'BLACKLIST_USER' && a.entity_id === s54FreshUserId);
  const s54HasDelAudit = s54AuditEntries.some(a => a.action === 'DELETE_ACCOUNT' && a.entity_id === s54FreshUserId);
  assert(s54HasBlAudit && s54HasDelAudit, 'admin_audit_log retains BLACKLIST_USER and DELETE_ACCOUNT rows for removed user');

  // Test 2: Stockist with a real order (Outcome: RELEASED)
  clearLogin();
  const s54OrderPhone = '9733000002';
  const s54OrderEmail = 'stk_order_973302@test.com';
  const s54OrderIdNum = '345678901239';

  const s54RegOrderRes = await post('http://localhost:3001/api/auth/register-stockist', {
    name: 'Order Stockist Two',
    phone: s54OrderPhone,
    email: s54OrderEmail,
    shop_name: 'Order Shop Two',
    address: 'Shop 2 Address, Town',
    region_id: 'r1',
    id_type: 'Aadhaar',
    id_number: s54OrderIdNum
  }, {
    asMultipart: true,
    fileObj: { fieldName: 'documentPhoto', filename: 'doc2.jpg', mime: 'image/jpeg', buffer: Buffer.from('mock photo') }
  });
  assert(s54RegOrderRes.status === 200 && s54RegOrderRes.body.success, 'Stockist 9733000002 registers successfully');
  const s54OrderUserId = s54RegOrderRes.body.user.id;

  // Add real order reference for this stockist
  const s54CurStockists = await dbModule.getTable('stockists');
  const s54TargetShop = s54CurStockists.find(s => s.user_id === s54OrderUserId);
  assert(s54TargetShop, 'Stockist shop found for order user');
  await dbModule.insertRow('orders', {
    id: 'ord-s54-test-1',
    stockist_id: s54TargetShop.id,
    customer_id: 'u-cust1',
    total_amount: 150,
    status: 'COMPLETED'
  });

  // Blacklist this stockist
  loginAs('u-admin', 'ADMIN');
  const s54BlOrderRes = await post(`http://localhost:3001/api/admin/users/${s54OrderUserId}/blacklist`, {
    reason: 'Policy violation with active orders'
  });
  assert(s54BlOrderRes.status === 200, 'Admin blacklists stockist with order');

  // References check: reports 1 order reference, audit rows not counted
  const s54OrderRefsRes = await get(`http://localhost:3001/api/admin/users/${s54OrderUserId}/references`);
  assert(s54OrderRefsRes.status === 200 && s54OrderRefsRes.body.reference_count === 1 && s54OrderRefsRes.body.references_by_table?.orders === 1, 'References check reports 1 order reference');

  // Admin removes the account -> action RELEASED
  const s54OrderDelRes = await del(`http://localhost:3001/api/admin/users/${s54OrderUserId}/account`);
  assert(s54OrderDelRes.status === 200 && s54OrderDelRes.body.action === 'RELEASED', 'Account with real order is RELEASED (not deleted)');

  // Verify identity is freed on user and stockist
  const s54UsersAfterRel = await dbModule.getTable('users');
  const s54RelUser = s54UsersAfterRel.find(u => u.id === s54OrderUserId);
  assert(s54RelUser && s54RelUser.kyc_status === 'RELEASED', 'User kyc_status is RELEASED');
  assert(s54RelUser.phone === null && s54RelUser.email === null, 'User phone and email are set to null');
  assert(s54RelUser.released_phone === s54OrderPhone && s54RelUser.released_email === s54OrderEmail, 'User phone and email moved to released_phone and released_email');
  assert(s54RelUser.released_at, 'User has released_at timestamp');

  const s54StockistsAfterRel = await dbModule.getTable('stockists');
  const s54RelShop = s54StockistsAfterRel.find(s => s.user_id === s54OrderUserId);
  assert(s54RelShop && s54RelShop.is_active === false, 'Stockist shop is_active is false');
  assert(s54RelShop.phone === null && s54RelShop.contact_phone === null, 'Stockist shop phone and contact_phone are null');
  assert(s54RelShop.released_phone === s54OrderPhone, 'Stockist shop released_phone preserves phone');

  // (a) send-otp for released phone returns no-account response (404)
  clearLogin();
  const s54RelSendOtpRes = await post('http://localhost:3001/api/stockist/auth/send-otp', {
    phone: s54OrderPhone
  });
  assert(s54RelSendOtpRes.status === 404 && s54RelSendOtpRes.body.error === 'No account found', 'send-otp for released phone returns 404 No account found');

  // (b) Register again with the same phone and email AND same ID succeeds with kyc_status PENDING
  const s54ReRegOrderRes = await post('http://localhost:3001/api/auth/register-stockist', {
    name: 'Order Stockist Two Reborn',
    phone: s54OrderPhone,
    email: s54OrderEmail,
    shop_name: 'Order Shop Two Reborn',
    address: 'Shop 2 Reborn Address, Town',
    region_id: 'r1',
    id_type: 'Aadhaar',
    id_number: s54OrderIdNum
  }, {
    asMultipart: true,
    fileObj: { fieldName: 'documentPhoto', filename: 'doc2_re.jpg', mime: 'image/jpeg', buffer: Buffer.from('mock photo') }
  });
  assert(s54ReRegOrderRes.status === 200 && s54ReRegOrderRes.body.user?.kyc_status === 'PENDING', 'Re-registering released phone and email succeeds with PENDING');
  const s54NewOrderUserId = s54ReRegOrderRes.body.user.id;

  // (c) The new user is in GET /api/admin/kyc-queue with the duplicate-ID flag
  loginAs('u-admin', 'ADMIN');
  const s54KycQueueRes = await get('http://localhost:3001/api/admin/kyc-queue');
  assert(s54KycQueueRes.status === 200 && Array.isArray(s54KycQueueRes.body), 'GET /api/admin/kyc-queue returns 200 array');
  const s54NewUserInQueue = s54KycQueueRes.body.find(u => u.id === s54NewOrderUserId);
  assert(s54NewUserInQueue !== undefined, 'New user is present in KYC queue');
  const s54DupIdFlag = s54NewUserInQueue.flags?.find(f => f.flag_type === 'DUPLICATE_ID');
  assert(s54DupIdFlag !== undefined, 'New user in KYC queue has DUPLICATE_ID flag for matching RELEASED record');

  // (d) admin_audit_log retains RELEASE_ACCOUNT row
  const s54AuditAfterRelRes = await get('http://localhost:3001/api/admin/audit-log');
  const s54HasRelAudit = (s54AuditAfterRelRes.body || []).some(a => a.action === 'RELEASE_ACCOUNT' && a.entity_id === s54OrderUserId);
  assert(s54HasRelAudit, 'admin_audit_log retains RELEASE_ACCOUNT entry for released user');

  // Test 3: Active BLACKLISTED user blocks re-registration with same ID number
  clearLogin();
  const s54BlActivePhone = '9733000003';
  const s54BlActiveIdNum = '456789012340';
  const s54RegBlRes = await post('http://localhost:3001/api/auth/register-stockist', {
    name: 'Active Blacklist Stockist',
    phone: s54BlActivePhone,
    email: 'stk_bl_active@test.com',
    shop_name: 'Active Blacklist Shop',
    address: 'Shop 3 Address, Town',
    region_id: 'r1',
    id_type: 'Aadhaar',
    id_number: s54BlActiveIdNum
  }, {
    asMultipart: true,
    fileObj: { fieldName: 'documentPhoto', filename: 'doc3.jpg', mime: 'image/jpeg', buffer: Buffer.from('mock photo') }
  });
  assert(s54RegBlRes.status === 200, 'Stockist 9733000003 registers successfully');
  const s54BlUserId = s54RegBlRes.body.user.id;

  loginAs('u-admin', 'ADMIN');
  await post(`http://localhost:3001/api/admin/users/${s54BlUserId}/blacklist`, {
    reason: 'Fraudulent activity'
  });

  // Re-registration with same ID number of ACTIVE blacklisted user is blocked
  clearLogin();
  const s54BlBlockedRes = await post('http://localhost:3001/api/auth/register-stockist', {
    name: 'Different Person Same ID',
    phone: '9733000004',
    email: 'diff_person@test.com',
    shop_name: 'Different Shop',
    address: 'Shop 4 Address, Town',
    region_id: 'r1',
    id_type: 'Aadhaar',
    id_number: s54BlActiveIdNum
  }, {
    asMultipart: true,
    fileObj: { fieldName: 'documentPhoto', filename: 'doc4.jpg', mime: 'image/jpeg', buffer: Buffer.from('mock photo') }
  });
  assert(s54BlBlockedRes.status === 403, 'Registration with ID matching active BLACKLISTED user is blocked with 403');

  // Test 4: Startup repair logic
  const s54LegacyUserId = 'u-legacy-released-1';
  await dbModule.insertRow('users', {
    id: s54LegacyUserId,
    name: 'Legacy Released User',
    phone: '9733000088',
    email: 'legacy_rel@test.com',
    role: 'STOCKIST',
    kyc_status: 'RELEASED'
  });
  await dbModule.insertRow('stockists', {
    id: 's-legacy-rel-1',
    user_id: s54LegacyUserId,
    name: 'Legacy Released Shop',
    phone: '9733000088',
    contact_phone: '9733000088',
    is_active: true
  });

  if (typeof dbModule.repairReleasedUsers === 'function') {
    const repairedCount = await dbModule.repairReleasedUsers(dbModule);
    assert(repairedCount >= 1, 'repairReleasedUsers repaired at least 1 user');
  }
  const s54RepairedUser = (await dbModule.getTable('users')).find(u => u.id === s54LegacyUserId);
  assert(s54RepairedUser && s54RepairedUser.phone === null && s54RepairedUser.released_phone === '9733000088', 'Startup repair set phone to null and populated released_phone');

  // Test 5: Admin UI toast check
  const s54AppJsx = fs.readFileSync(path.join(__dirname, '../../../frontend/src/App.jsx'), 'utf8');
  assert(s54AppJsx.includes("Account removed. This number can register again.") && s54AppJsx.includes("অ্যাকাউন্ট সরানো হয়েছে। এই নম্বরটি আবার নিবন্ধন করতে পারে।"), 'Admin UI contains translated Account removed toast');

};
