const { calculateAuthoritativeQuote, calculateExclusiveGst } = require('../utils/gstCalculator');
const { validatePhoneNumber } = require('../utils/phoneValidator');

const ACTIVE_BOOKING_STATUSES = ['HOLD', 'CONFIRMED', 'CHECKED_IN'];

const parseStay = input => {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(String(input.check_in || '')) || !datePattern.test(String(input.check_out || ''))) {
    return { error: 'check_in and check_out must use YYYY-MM-DD' };
  }
  const checkIn = new Date(`${input.check_in}T00:00:00.000Z`);
  const checkOut = new Date(`${input.check_out}T00:00:00.000Z`);
  if (Number.isNaN(checkIn.getTime()) || Number.isNaN(checkOut.getTime()) || checkOut <= checkIn) {
    return { error: 'check_out must be after check_in' };
  }
  const counts = {};
  for (const [field, fallback] of [['adults', 1], ['children', 0], ['infants', 0], ['pets', 0]]) {
    const value = input[field] == null || input[field] === '' ? fallback : Number(input[field]);
    if (!Number.isInteger(value) || value < 0 || (field === 'adults' && value < 1)) {
      return { error: 'adults must be at least 1 and all guest counts must be non-negative whole numbers' };
    }
    counts[field] = value;
  }
  return {
    ...counts,
    check_in: input.check_in,
    check_out: input.check_out,
    nights: Math.round((checkOut - checkIn) / 86400000),
    total_occupants: counts.adults + counts.children + counts.infants,
    priced_guests: counts.adults + counts.children
  };
};

const getActiveMobileDiscount = async (db, mobileNumber) => {
  if (!mobileNumber) return null;
  const result = await db.query(
    `SELECT id, discount_percentage, reason, valid_until
       FROM mobile_discount_offers
      WHERE mobile_number = $1 AND status = 'ACTIVE'
        AND valid_from <= CURRENT_TIMESTAMP
        AND (valid_until IS NULL OR valid_until > CURRENT_TIMESTAMP)
      LIMIT 1`,
    [mobileNumber]
  );
  return result.rows[0] || null;
};

const findAvailableProperties = async (db, input) => {
  const stay = parseStay(input);
  if (stay.error) return { error: stay.error, status: 400 };

  let mobileDiscount = null;
  const rawMobile = input.mobile_number || input.whatsapp_number || input.phone;
  if (rawMobile) {
    const mobile = validatePhoneNumber(rawMobile, input.country_code || input.phone_country_code || 'IN');
    if (mobile.valid) {
      mobileDiscount = await getActiveMobileDiscount(db, mobile.normalizedNumber);
    }
  }

  const result = await db.query(
    `SELECT p.id, p.property_code, p.property_name, p.property_type, p.area, p.city,
            p.bedrooms, p.bathrooms, p.max_guests, p.base_price, p.included_guests,
            p.extra_guest_price, p.currency, p.gst_enabled, p.gst_rate, p.price_includes_gst,
            p.airbnb_url
       FROM properties p
      WHERE p.status = 'ACTIVE'
        AND (p.price_includes_gst IS FALSE OR p.price_includes_gst IS NULL)
        AND (p.max_guests IS NULL OR p.max_guests >= $3)
        AND NOT EXISTS (
          SELECT 1 FROM bookings b
           WHERE b.property_id = p.id
             AND b.booking_status = ANY($4::text[])
             AND b.check_in < $2::date AND b.check_out > $1::date
        )
        AND NOT EXISTS (
          SELECT 1 FROM property_blocks pb
           WHERE pb.property_id = p.id
             AND pb.start_date < $2::date AND pb.end_date > $1::date
        )
      ORDER BY p.property_name`,
    [stay.check_in, stay.check_out, stay.total_occupants, ACTIVE_BOOKING_STATUSES]
  );

  const properties = result.rows.map(property => ({
    ...property,
    available: true,
    quote: calculateAuthoritativeQuote({
      property,
      stay,
      discountOffer: mobileDiscount
    })
  }));
  return { stay, properties };
};

module.exports = {
  ACTIVE_BOOKING_STATUSES,
  parseStay,
  findAvailableProperties,
  getActiveMobileDiscount,
  calculateAuthoritativeQuote
};
