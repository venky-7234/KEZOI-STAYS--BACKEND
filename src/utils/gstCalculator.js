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

const calculateAuthoritativeQuote = ({
  property,
  stay,
  discountOffer = null
}) => {
  if (property.price_includes_gst) {
    const error = new Error('GST-inclusive property pricing is not supported by this pricing configuration');
    error.status = 500;
    throw error;
  }
  const nights = stay.nights;
  const basePrice = Number(property.base_price || 0);
  const includedGuests = Number(property.included_guests || 6);
  const extraGuestPrice = Number(property.extra_guest_price || 0);
  const pricedGuests = stay.priced_guests ?? (stay.pricedGuests ?? (Number(stay.adults || 1) + Number(stay.children || 0)));
  const extraGuests = Math.max(0, pricedGuests - includedGuests);
  const baseAmount = roundMoney(basePrice * nights);
  const extraGuestAmount = roundMoney(extraGuests * extraGuestPrice * nights);
  const originalAmount = roundMoney(baseAmount + extraGuestAmount);

  const discountPercentage = Number(discountOffer?.discount_percentage || 0);
  const discountAmount = roundMoney((originalAmount * discountPercentage) / 100);

  const gstRate = property.gst_rate ?? Number(process.env.DEFAULT_GST_RATE || 18);
  const gstEnabled = property.gst_enabled !== false;

  const tax = calculateExclusiveGst({
    baseAmount,
    extraGuestAmount,
    discountAmount,
    gstRate,
    gstEnabled
  });

  const currency = property.currency || process.env.DEFAULT_CURRENCY || 'INR';

  return {
    nights,
    base_price_per_night: basePrice,
    included_guests: includedGuests,
    extra_guests: extraGuests,
    extra_guest_price_per_night: extraGuestPrice,
    base_amount: baseAmount,
    extra_guest_amount: extraGuestAmount,
    original_amount: originalAmount,
    actual_price: originalAmount,
    discount_percentage: discountPercentage,
    discount_amount: discountAmount,
    discount_for_you: discountAmount,
    taxable_amount: tax.taxable_amount,
    gst_rate: tax.gst_rate,
    cgst_rate: tax.cgst_rate,
    cgst_amount: tax.cgst_amount,
    sgst_rate: tax.sgst_rate,
    sgst_amount: tax.sgst_amount,
    igst_rate: tax.igst_rate,
    igst_amount: tax.igst_amount,
    gst_amount: tax.gst_amount,
    currency,
    price_includes_gst: false,
    final_amount: tax.total_amount,
    total_amount: tax.total_amount,
    mobile_discount_applied: Boolean(discountOffer),
    mobile_discount_offer_id: discountOffer?.id || null,
    discount_reason: discountOffer?.reason || null,
    discount_valid_until: discountOffer?.valid_until || null
  };
};

module.exports = { calculateExclusiveGst, roundMoney, calculateAuthoritativeQuote };
