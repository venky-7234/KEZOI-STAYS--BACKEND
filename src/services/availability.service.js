const { calculateExclusiveGst } = require('../utils/gstCalculator');

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

const findAvailableProperties = async (db, input) => {
  const stay = parseStay(input);
  if (stay.error) return { error: stay.error, status: 400 };

  const result = await db.query(
    `SELECT p.id, p.property_code, p.property_name, p.property_type, p.area, p.city,
            p.bedrooms, p.bathrooms, p.max_guests, p.base_price, p.included_guests,
            p.extra_guest_price, p.currency, p.gst_enabled, p.gst_rate, p.price_includes_gst,
            p.airbnb_url
       FROM properties p
      WHERE p.status = 'ACTIVE'
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

  const properties = result.rows.map(property => {
    const baseAmount = Number(property.base_price || 0) * stay.nights;
    const extraGuests = Math.max(0, stay.priced_guests - Number(property.included_guests || 6));
    const extraGuestAmount = extraGuests * Number(property.extra_guest_price || 0) * stay.nights;
    const tax = calculateExclusiveGst({
      baseAmount,
      extraGuestAmount,
      gstRate: property.gst_rate ?? 18,
      gstEnabled: property.gst_enabled !== false
    });
    return {
      ...property,
      available: true,
      quote: {
        nights: stay.nights,
        base_amount: baseAmount,
        extra_guests: extraGuests,
        extra_guest_amount: extraGuestAmount,
        taxable_amount: tax.taxable_amount,
        gst_rate: tax.gst_rate,
        cgst_amount: tax.cgst_amount,
        sgst_amount: tax.sgst_amount,
        gst_amount: tax.gst_amount,
        total_amount: tax.total_amount,
        currency: property.currency || 'INR',
        price_includes_gst: false
      }
    };
  });
  return { stay, properties };
};

module.exports = { ACTIVE_BOOKING_STATUSES, parseStay, findAvailableProperties };
