const validatePayoutFields = (body) => {
  const values = {};
  
  if (body.payout_upi_id !== undefined) {
    if (body.payout_upi_id !== '' && !/^[a-z0-9.\-_]{2,}@[a-z]{2,}$/.test(body.payout_upi_id.trim().toLowerCase())) {
      return { ok: false, error: 'Enter a valid UPI ID like name@bank.' };
    }
    values.payout_upi_id = body.payout_upi_id ? body.payout_upi_id.trim().toLowerCase() : '';
  }
  
  // Notice: caller maps this appropriately depending on entity (payout_bank_ifsc vs payout_ifsc)
  const ifscKey = body.payout_bank_ifsc !== undefined ? 'payout_bank_ifsc' : (body.payout_ifsc !== undefined ? 'payout_ifsc' : null);
  if (ifscKey) {
    const val = body[ifscKey];
    if (val !== '' && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(val ? val.trim().toUpperCase() : '')) {
      return { ok: false, error: 'IFSC must be 11 characters, like SBIN0000300.' };
    }
    values[ifscKey] = val ? val.trim().toUpperCase() : '';
  }

  if (body.payout_bank_account !== undefined) {
    if (body.payout_bank_account !== '' && !/^\d{9,18}$/.test(body.payout_bank_account.trim())) {
      return { ok: false, error: 'Bank account number must be 9 to 18 digits.' };
    }
    values.payout_bank_account = body.payout_bank_account ? body.payout_bank_account.trim() : '';
  }

  if (body.payout_account_name !== undefined) {
    if (body.payout_account_name !== '' && (body.payout_account_name.length < 2 || body.payout_account_name.length > 80)) {
      return { ok: false, error: "Enter the account holder's name." };
    }
    values.payout_account_name = body.payout_account_name ? body.payout_account_name.trim() : '';
  }

  return { ok: true, values };
};

module.exports = {
  validatePayoutFields
};
