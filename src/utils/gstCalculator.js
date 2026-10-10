const roundMoney = value => Number(Number(value).toFixed(2));

const calculateExclusiveGst = ({
  baseAmount,
  extraGuestAmount = 0,
  discountAmount = 0,
  gstRate = 18,
  gstEnabled = true
}) => {
  const base = roundMoney(baseAmount);
  const extras = roundMoney(extraGuestAmount);
  const discount = roundMoney(discountAmount);
  const rate = gstEnabled ? Number(gstRate) : 0;

  if (![base, extras, discount, rate].every(Number.isFinite) ||
      base < 0 || extras < 0 || discount < 0 || rate < 0 || rate > 100) {
    throw new TypeError('GST amounts and rate must be valid non-negative numbers');
  }

  const grossAmount = roundMoney(base + extras);
  if (discount > grossAmount) {
    throw new RangeError('Discount cannot exceed the gross amount');
  }

  const taxableAmount = roundMoney(grossAmount - discount);
  const gstAmount = roundMoney(taxableAmount * rate / 100);
  const cgstAmount = roundMoney(gstAmount / 2);
  const sgstAmount = roundMoney(gstAmount - cgstAmount);

  return {
    gross_amount: grossAmount,
    taxable_amount: taxableAmount,
    gst_rate: rate,
    cgst_rate: roundMoney(rate / 2),
    cgst_amount: cgstAmount,
    sgst_rate: roundMoney(rate / 2),
    sgst_amount: sgstAmount,
    igst_rate: 0,
    igst_amount: 0,
    gst_amount: gstAmount,
    total_amount: roundMoney(taxableAmount + gstAmount)
  };
};

module.exports = { calculateExclusiveGst, roundMoney };
