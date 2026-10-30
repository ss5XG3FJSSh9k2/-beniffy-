// Message Template Registry for Indian Telecom DLT & Meta WhatsApp Notifications
// Languages supported: English ('en'), Hindi ('hi'), Bengali ('bn')

const TEMPLATES = {
  LOGIN_OTP: {
    key: 'LOGIN_OTP',
    dltEnvKey: 'DLT_TEMPLATE_LOGIN_OTP',
    en: 'Your Beniffy verification code is {{otp}}. Valid for 10 minutes. Do not share this code with anyone.',
    hi: 'आपका Beniffy सत्यापन कोड {{otp}} है। 10 मिनट के लिए मान्य। यह कोड किसी के साथ साझा न करें।',
    bn: 'আপনার Beniffy যাচাইকরণ কোডটি হলো {{otp}}। ১০ মিনিটের জন্য বৈধ। এই কোডটি কারো সাথে শেয়ার করবেন না।'
  },
  SIGNUP_OTP: {
    key: 'SIGNUP_OTP',
    dltEnvKey: 'DLT_TEMPLATE_SIGNUP_OTP',
    en: 'Welcome to Beniffy! Your registration code is {{otp}}. Valid for 10 minutes.',
    hi: 'Beniffy में आपका स्वागत है! आपका पंजीकरण कोड {{otp}} है। 10 मिनट के लिए मान्य।',
    bn: 'Beniffy-তে স্বাগতম! আপনার নিবন্ধকরণ কোডটি হলো {{otp}}। ১০ মিনিটের জন্য বৈধ।'
  },
  PHONE_CHANGE_OTP: {
    key: 'PHONE_CHANGE_OTP',
    dltEnvKey: 'DLT_TEMPLATE_PHONE_CHANGE_OTP',
    en: 'Your Beniffy verification code to change your phone number is {{otp}}. Valid for 10 minutes.',
    hi: 'अपना फ़ोन नंबर बदलने के लिए आपका Beniffy सत्यापन कोड {{otp}} है। 10 मिनट के लिए मान्य।',
    bn: 'আপনার ফোন নম্বর পরিবর্তন করার জন্য Beniffy যাচাইকরণ কোডটি হলো {{otp}}। ১০ মিনিটের জন্য বৈধ।'
  },
  ORDER_PLACED: {
    key: 'ORDER_PLACED',
    dltEnvKey: 'DLT_TEMPLATE_ORDER_PLACED',
    metaEnvKey: 'WHATSAPP_TEMPLATE_ORDER_PLACED',
    metaDefaultName: 'order_placed',
    en: 'Beniffy: Order #{{orderId}} confirmed at {{shopName}} for ₹{{amount}}. Track your order in the app.',
    hi: 'Beniffy: {{shopName}} पर ₹{{amount}} के लिए ऑर्डर #{{orderId}} की पुष्टि हो गई है। ऐप में ट्रैक करें।',
    bn: 'Beniffy: {{shopName}}-এ ₹{{amount}} মূল্যের অর্ডার #{{orderId}} নিশ্চিত হয়েছে। অ্যাপে ট্র্যাক করুন।'
  },
  READY_FOR_PICKUP: {
    key: 'READY_FOR_PICKUP',
    dltEnvKey: 'DLT_TEMPLATE_READY_FOR_PICKUP',
    metaEnvKey: 'WHATSAPP_TEMPLATE_READY_FOR_PICKUP',
    metaDefaultName: 'ready_for_pickup',
    en: 'Beniffy: Order #{{orderId}} is ready for pickup at {{shopName}}. Your pickup PIN is {{pin}}. Please collect within 24 hours.',
    hi: 'Beniffy: ऑर्डर #{{orderId}} {{shopName}} पर पिकअप के लिए तैयार है। आपका पिकअप पिन {{pin}} है। कृपया 24 घंटे के भीतर ले लें।',
    bn: 'Beniffy: অর্ডার #{{orderId}} {{shopName}}-এ তোলার জন্য প্রস্তুত। আপনার পিকআপ পিন {{pin}}। দয়া করে ২৪ ঘণ্টার মধ্যে সংগ্রহ করুন।'
  },
  OUT_FOR_DELIVERY: {
    key: 'OUT_FOR_DELIVERY',
    dltEnvKey: 'DLT_TEMPLATE_OUT_FOR_DELIVERY',
    metaEnvKey: 'WHATSAPP_TEMPLATE_OUT_FOR_DELIVERY',
    metaDefaultName: 'out_for_delivery',
    en: 'Beniffy: Order #{{orderId}} from {{shopName}} is out for delivery. Keep payment ready if paying at handover.',
    hi: 'Beniffy: {{shopName}} से ऑर्डर #{{orderId}} डिलीवरी के लिए निकल चुका है। हैंडओवर पर भुगतान के लिए तैयार रहें।',
    bn: 'Beniffy: {{shopName}} থেকে অর্ডার #{{orderId}} ডেলিভারির জন্য রওনা হয়েছে। হস্তান্তরে অর্থপ্রদানের জন্য প্রস্তুত থাকুন।'
  },
  ORDER_DELIVERED: {
    key: 'ORDER_DELIVERED',
    dltEnvKey: 'DLT_TEMPLATE_ORDER_DELIVERED',
    metaEnvKey: 'WHATSAPP_TEMPLATE_ORDER_DELIVERED',
    metaDefaultName: 'order_delivered',
    en: 'Beniffy: Order #{{orderId}} has been delivered. Points earned: {{points}}. Thank you for shopping with us!',
    hi: 'Beniffy: ऑर्डर #{{orderId}} डिलीवर हो गया है। अर्जित पॉइंट्स: {{points}}। हमारे साथ खरीदारी करने के लिए धन्यवाद!',
    bn: 'Beniffy: অর্ডার #{{orderId}} সফলভাবে পৌঁছে দেওয়া হয়েছে। অর্জিত পয়েন্ট: {{points}}। আমাদের সাথে কেনাকাটার জন্য ধন্যবাদ!'
  },
  ORDER_CANCELLED: {
    key: 'ORDER_CANCELLED',
    dltEnvKey: 'DLT_TEMPLATE_ORDER_CANCELLED',
    metaEnvKey: 'WHATSAPP_TEMPLATE_ORDER_CANCELLED',
    metaDefaultName: 'order_cancelled',
    en: 'Beniffy: Order #{{orderId}} has been cancelled.',
    hi: 'Beniffy: ऑर्डर #{{orderId}} रद्द कर दिया गया है।',
    bn: 'Beniffy: অর্ডার #{{orderId}} বাতিল করা হয়েছে।'
  },
  KYC_APPROVED: {
    key: 'KYC_APPROVED',
    dltEnvKey: 'DLT_TEMPLATE_KYC_APPROVED',
    en: 'Beniffy: Congratulations! Your shop KYC verification has been approved. You can now accept orders.',
    hi: 'Beniffy: बधाई हो! आपकी दुकान का केवाईसी सत्यापन स्वीकृत हो गया है। अब आप ऑर्डर स्वीकार कर सकते हैं।',
    bn: 'Beniffy: অভিনন্দন! আপনার দোকানের কেওয়াইসি যাচাইকরণ অনুমোদিত হয়েছে। আপনি এখন অর্ডার গ্রহণ করতে পারেন।'
  },
  KYC_REJECTED: {
    key: 'KYC_REJECTED',
    dltEnvKey: 'DLT_TEMPLATE_KYC_REJECTED',
    en: 'Beniffy: Your KYC verification could not be approved. Reason: {{reason}}. You can reapply in the app.',
    hi: 'Beniffy: आपका केवाईसी सत्यापन स्वीकृत नहीं हो सका। कारण: {{reason}}। आप ऐप में पुनः आवेदन कर सकते हैं।',
    bn: 'Beniffy: আপনার কেওয়াইসি যাচাইকরণ অনুমোদিত হতে পারেনি। কারণ: {{reason}}। আপনি অ্যাপে পুনরায় আবেদন করতে পারেন।'
  },
  PAYOUT_SENT: {
    key: 'PAYOUT_SENT',
    dltEnvKey: 'DLT_TEMPLATE_PAYOUT_SENT',
    en: 'Beniffy: A payout of ₹{{amount}} has been initiated for your shop. Check your bank account within 24-48 hours.',
    hi: 'Beniffy: आपकी दुकान के लिए ₹{{amount}} का भुगतान भेज दिया गया है। 24-48 घंटों के भीतर अपना बैंक खाता देखें।',
    bn: 'Beniffy: আপনার দোকানের জন্য ₹{{amount}}-এর অর্থপ্রদান শুরু হয়েছে। ২৪-৪৮ ঘণ্টার মধ্যে আপনার ব্যাঙ্ক অ্যাকাউন্ট পরীক্ষা করুন।'
  }
};

function getTemplate(templateKey) {
  return TEMPLATES[templateKey] || null;
}

function getDltTemplateId(templateKey) {
  const tmpl = TEMPLATES[templateKey];
  if (!tmpl) return null;
  const val = process.env[tmpl.dltEnvKey];
  if (!val || val.includes('placeholder') || val.includes('your_')) return null;
  return val.trim();
}

function getMetaTemplateName(templateKey) {
  const tmpl = TEMPLATES[templateKey];
  if (!tmpl) return null;
  if (tmpl.metaEnvKey && process.env[tmpl.metaEnvKey] && !process.env[tmpl.metaEnvKey].includes('placeholder')) {
    return process.env[tmpl.metaEnvKey].trim();
  }
  return tmpl.metaDefaultName || templateKey.toLowerCase();
}

function renderTemplate(templateKey, lang = 'en', params = {}) {
  const tmpl = TEMPLATES[templateKey];
  if (!tmpl) {
    throw new Error(`Unknown message template: ${templateKey}`);
  }
  const cleanLang = (lang || 'en').toLowerCase();
  const rawText = tmpl[cleanLang] || tmpl['en'];

  let rendered = rawText;
  for (const [key, val] of Object.entries(params)) {
    const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    rendered = rendered.replace(regex, val !== undefined && val !== null ? String(val) : '');
  }

  // Clean up any remaining unreplaced placeholders
  rendered = rendered.replace(/\{\{[a-zA-Z0-9_]+\}\}/g, '').trim();
  return rendered;
}

function getAllTemplates() {
  return TEMPLATES;
}

module.exports = {
  TEMPLATES,
  getTemplate,
  getDltTemplateId,
  getMetaTemplateName,
  renderTemplate,
  getAllTemplates
};
