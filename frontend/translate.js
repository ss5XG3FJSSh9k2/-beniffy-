const fs = require('fs');
let code = fs.readFileSync('frontend/src/App.jsx', 'utf8');

const reps = [
  // Shop Status section
  ['<span style={{ fontSize: \\'0.8rem\\', color: \\'var(--text-muted)\\' }}>Shop Status:</span>', '<span style={{ fontSize: \\'0.8rem\\', color: \\'var(--text-muted)\\' }}>{t(\\'Shop Status\\', \\'दुकान की स्थिति\\', \\'দোকানের অবস্থা\\')}:</span>'],
  ['{stockistProfile.manual_closed ? (\\n                              <span style={{ color: \\'var(--danger-color)\\', fontWeight: \\'bold\\' }}>Closed</span>\\n                            ) : (\\n                              <span style={{ color: \\'var(--accent-color)\\', fontWeight: \\'bold\\' }}>Open</span>\\n                            )}', '{stockistProfile.manual_closed ? (\\n                              <span style={{ color: \\'var(--danger-color)\\', fontWeight: \\'bold\\' }}>{t(\\'Closed\\',\\'बंद\\',\\'বন্ধ\\')}</span>\\n                            ) : (\\n                              <span style={{ color: \\'var(--accent-color)\\', fontWeight: \\'bold\\' }}>{t(\\'Open\\',\\'खुला\\',\\'খোলা\\')}</span>\\n                            )}'],
  ['<span className=\"shop-toggle-label\">{stockistProfile.manual_closed ? \\'CLOSE\\' : \\'OPEN\\'}</span>', '<span className=\"shop-toggle-label\">{stockistProfile.manual_closed ? t(\\'CLOSE\\',\\'बंद\\',\\'বন্ধ\\') : t(\\'OPEN\\',\\'खुला\\',\\'খোলা\\')}</span>'],
  ['Until next opening <span style={{ fontSize: \\'0.7rem\\', opacity: 0.8 }}>(Shop reopens automatically at your next opening time)</span>', '{t(\\'Until next opening\\', \\'अगले खुलने तक\\', \\'পরবর্তী খোলা পর্যন্ত\\')} <span style={{ fontSize: \\'0.7rem\\', opacity: 0.8 }}>({t(\\'Shop reopens automatically at your next opening time\\', \\'आपकी अगली खुलने के समय दुकान अपने आप खुल जाएगी\\', \\'আপনার পরবর্তী খোলার সময়ে দোকানটি স্বয়ংক্রিয়ভাবে খুলে যাবে\\')})</span>'],
  ['>\\n                                2 hours\\n                              </button>', '>\\n                                {t(\\'2 hours\\', \\'2 घंटे\\', \\'২ ঘন্টা\\')}\\n                              </button>'],
  ['>\\n                                Tomorrow morning\\n                              </button>', '>\\n                                {t(\\'Tomorrow morning\\', \\'कल सुबह\\', \\'আগামীকাল সকালে\\')}\\n                              </button>'],
  ['Specific date <span style={{ fontSize: \\'0.7rem\\', opacity: 0.8 }}>(e.g. back from vacation)</span>', '{t(\\'Specific date\\', \\'विशिष्ट तिथि\\', \\'নির্দিষ্ট তারিখ\\')} <span style={{ fontSize: \\'0.7rem\\', opacity: 0.8 }}>({t(\\'e.g. back from vacation\\', \\'जैसे छुट्टी से वापसी\\', \\'যেমন ছুটি থেকে ফেরা\\')})</span>'],
  ['<label className=\"input-label\">Closed until (Optional)</label>', '<label className=\"input-label\">{t(\\'Closed until (Optional)\\', \\'तक बंद (वैकल्पिक)\\', \\'পর্যন্ত বন্ধ (ঐচ্ছিক)\\')}</label>'],
  ['<strong>Selected: </strong>', '<strong>{t(\\'Selected:\\', \\'चयनित:\\', \\'নির্বাচিত:\\')} </strong>'],
  ['Reopens at next opening time', '{t(\\'Reopens at next opening time\\', \\'अगले खुलने के समय खुलेगा\\', \\'পরবর্তী খোলার সময়ে পুনরায় খুলবে\\')}'],
  ['(Unsaved)</span>}', '{t(\\'(Unsaved)\\', \\'(सहेजा नहीं गया)\\', \\'(সংরক্ষিত নয়)\\')}</span>}'],
  ['>Cancel</button>', '>{t(\\'Cancel\\', \\'रद्द करें\\', \\'বাতিল করুন\\')}</button>'],
  ['>OK</button>', '>{t(\\'OK\\', \\'ठीक है\\', \\'ঠিক আছে\\')}</button>'],

  // Operational Settings
  ['<h3>Operational Settings</h3>', '<h3>{t(\\'Operational Settings\\', \\'परिचालन सेटिंग\\', \\'পরিচালন সেটিংস\\')}</h3>'],
  ['<label className=\"input-label\">Opening Time</label>', '<label className=\"input-label\">{t(\\'Opening Time\\', \\'खुलने का समय\\', \\'খোলার সময়\\')}</label>'],
  ['<label className=\"input-label\">Closing Time</label>', '<label className=\"input-label\">{t(\\'Closing Time\\', \\'बंद होने का समय\\', \\'বন্ধের সময়\\')}</label>'],
  ['<label className=\"input-label\">Preparation Time (minutes)</label>', '<label className=\"input-label\">{t(\\'Preparation Time (minutes)\\', \\'तैयारी का समय (मिनट)\\', \\'প্রস্তুতির সময় (মিনিট)\\')}</label>'],
  ['<label className=\"input-label\">Delivery Radius (km)</label>', '<label className=\"input-label\">{t(\\'Delivery Radius (km)\\', \\'डिलीवरी का दायरा (किमी)\\', \\'ডেলিভারি ব্যাসার্ধ (কিমি)\\')}</label>'],
  ['<span style={{ fontSize: \\'0.75rem\\', color: \\'var(--text-muted)\\' }}>Maximum allowed: {', '<span style={{ fontSize: \\'0.75rem\\', color: \\'var(--text-muted)\\' }}>{t(\\'Maximum allowed\\', \\'अधिकतम अनुमत\\', \\'সর্বাধিক অনুমোদিত\\')}: {'],
  ['} km</span>', '} {t(\\'km\\', \\'किमी\\', \\'কিমি\\')}</span>'],

  // Payout Details
  ['<h3>Payout Details</h3>', '<h3>{t(\\'Payout Details\\', \\'भुगतान विवरण\\', \\'পেআউট বিবরণ\\')}</h3>'],
  ['<label className=\"input-label\">UPI ID (Primary)</label>', '<label className=\"input-label\">{t(\\'UPI ID (Primary)\\', \\'UPI आईडी (प्राथमिक)\\', \\'UPI আইডি (प्राथमिक)\\')}</label>'],
  ['<label className=\"input-label\">Bank Account Number (Fallback)</label>', '<label className=\"input-label\">{t(\\'Bank Account Number (Fallback)\\', \\'बैंक खाता संख्या (वैकल्पिक)\\', \\'ব্যাংক অ্যাকাউন্ট নম্বর (বিকল্প)\\')}</label>'],
  ['<label className=\"input-label\">IFSC Code</label>', '<label className=\"input-label\">{t(\\'IFSC Code\\', \\'IFSC कोड\\', \\'IFSC কোড\\')}</label>'],
  ['<label className=\"input-label\">Account Holder Name</label>', '<label className=\"input-label\">{t(\\'Account Holder Name\\', \\'खाताधारक का नाम\\', \\'অ্যাকাউন্ট হোল্ডারের নাম\\')}</label>'],

  // Account Information
  ['<h3>Account Information</h3>', '<h3>{t(\\'Account Information\\', \\'खाता जानकारी\\', \\'অ্যাকাউন্ট তথ্য\\')}</h3>'],
  ['<strong>Region:</strong>', '<strong>{t(\\'Region\\',\\'क्षेत्र\\',\\'অঞ্চল\\')}:</strong>'],
  ['<strong>Wholesaler:</strong>', '<strong>{t(\\'Wholesaler\\',\\'थोक विक्रेता\\',\\'পাইকারি বিক্রেতা\\')}:</strong>'],
  ['<strong>Current Commission Rate:</strong>', '<strong>{t(\\'Current Commission Rate\\',\\'वर्तमान कमीशन दर\\',\\'বর্তমান कमीशन हार\\')}:</strong>'],
  ['<strong>Minimum Order:</strong>', '<strong>{t(\\'Minimum Order\\',\\'न्यूनतम ऑर्डर\\',\\'সর্বনিম্ন অর্ডার\\')}:</strong>'],
  ['Contact Beniffy support to change any of these details.', '{t(\\'Contact Beniffy support to change any of these details.\\', \\'इन विवरणों को बदलने के लिए Beniffy सहायता से संपर्क करें।\\', \\'এই বিবরণগুলি পরিবর্তন করতে Beniffy সহায়তার সাথে যোগাযোগ করুন।\\')}'],

  // App Preferences
  ['<h3>App Preferences</h3>', '<h3>{t(\\'App Preferences\\', \\'ऐप प्राथमिकताएं\\', \\'অ্যাপ পছন্দসমূহ\\')}</h3>'],
  ['>Order Alerts (Push)</span>', '>{t(\\'Order Alerts (Push)\\', \\'ऑर्डर अलर्ट (पुश)\\', \\'অর্ডার সতর্কতা (পুশ)\\')}</span>'],
  ['>\\n                            Enable\\n                          </button>', '>\\n                            {t(\\'Enable\\',\\'सक्षम करें\\',\\'সক্ষম করুন\\')}\\n                          </button>'],
  ['>Language</span>', '>{t(\\'Language\\',\\'भाषा\\',\\'ভাষা\\')}</span>'],
  ['>Phone Number</span>', '>{t(\\'Phone Number\\',\\'फ़ोन नंबर\\',\\'ফোন নম্বর\\')}</span>'],
  ['>\\n                            Change\\n                          </button>', '>\\n                            {t(\\'Change\\',\\'बदलें\\',\\'পরিবর্তন\\')}\\n                          </button>'],

  // Toast / Status strings
  ['showToast(err.error || \\'Failed to save settings\\', \\'error\\')', 'showToast(err.error || t(\\'Failed to save settings\\', \\'सेटिंग्स सहेजने में विफल\\', \\'সেটিংস সংরক্ষণ করতে ব্যর্থ\\'), \\'error\\')'],
  ['showToast(\\'Settings saved successfully\\', \\'success\\')', 'showToast(t(\\'Settings saved successfully\\', \\'सेटिंग्स सफलतापूर्वक सहेजी गईं\\', \\'সেটিংস সফলভাবে সংরক্ষিত হয়েছে\\'), \\'success\\')'],
  ['showToast(\\'Network error\\', \\'error\\')', 'showToast(t(\\'Network error\\', \\'नेटवर्क त्रुटि\\', \\'নেটওয়ার্ক ত্রুটি\\'), \\'error\\')'],
  ['{savingSettings ? \\'Saving...\\' : \\'Save Settings\\'}', '{savingSettings ? t(\\'Saving...\\',\\'सहेजा जा रहा है...\\',\\'সংরক্ষণ করা হচ্ছে...\\') : t(\\'Save Settings\\',\\'सेटिंग्स सहेजें\\',\\'সেটিংস সংরক্ষণ করুন\\')}']
];

let changedCount = 0;
for (let i = 0; i < reps.length; i++) {
  const [target, replacement] = reps[i];
  if (code.includes(target)) {
    code = code.replace(target, replacement);
    changedCount++;
  } else {
    console.log(`Could not find replacement for index ${i}:`);
    console.log(target.substring(0, 50));
  }
}

fs.writeFileSync('frontend/src/App.jsx', code);
console.log('Replaced ' + changedCount + ' strings');
