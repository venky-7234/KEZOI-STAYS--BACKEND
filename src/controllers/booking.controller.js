const pool = require('../config/database');
const {
  triggerBookingWhatsAppAutomation
} = require('../services/whatsapp.service');
const { validatePhoneNumber, INVALID_MOBILE_MESSAGE } = require('../utils/phoneValidator');

const generateBookingReference = () => {
  const now = new Date();

  const datePart = now
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '');

  const randomPart = Math.floor(
    1000 + Math.random() * 9000
  );

  return `KZ-${datePart}-${randomPart}`;
};


// ======================================================
// CREATE BOOKING
// ======================================================

const createBooking = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      guest_id,
      property_id,
      enquiry_id,

      check_in,
      check_out,

      adults = 1,
      children = 0,

      taxes = 0,
      discount_amount = 0,

      source = 'DIRECT',

      special_requests
    } = req.body;

    if (
      !guest_id ||
      !property_id ||
      !check_in ||
      !check_out
    ) {
      return res.status(400).json({
        success: false,
        message:
          'guest_id, property_id, check_in and check_out are required'
      });
    }

    const parsedTaxes = Number(taxes);
    let parsedDiscount = Number(discount_amount);
    let discountReason = String(req.body.discount_reason || '').trim() || null;
    if (!Number.isFinite(parsedTaxes) || parsedTaxes < 0 ||
        !Number.isFinite(parsedDiscount) || parsedDiscount < 0) {
      return res.status(400).json({
        success: false,
        message: 'Taxes and discount amount must be valid non-negative numbers'
      });
    }

    const checkInDate = new Date(check_in);
    const checkOutDate = new Date(check_out);

    if (checkOutDate <= checkInDate) {
      return res.status(400).json({
        success: false,
        message:
          'Check-out date must be after check-in date'
      });
    }

    const millisecondsPerDay =
      1000 * 60 * 60 * 24;

    const nights = Math.round(
      (checkOutDate - checkInDate) /
      millisecondsPerDay
    );

    await client.query('BEGIN');

    // ==================================================
    // CHECK GUEST
    // ==================================================

    const guestResult = await client.query(
      `
      SELECT *
      FROM guests
      WHERE id = $1
      `,
      [guest_id]
    );

    if (guestResult.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        success: false,
        message: 'Guest not found'
      });
    }

    // ==================================================
    // CHECK PROPERTY
    // ==================================================

    const propertyResult = await client.query(
      `
      SELECT *
      FROM properties
      WHERE id = $1
      `,
      [property_id]
    );

    if (propertyResult.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    const property = propertyResult.rows[0];

    // Carry the server-calculated mobile offer into the booking when an
    // application is converted. A manually supplied discount still wins.
    if (enquiry_id && req.body.discount_amount === undefined) {
      const enquiryDiscount = await client.query(
        `SELECT e.discount_amount, d.reason
           FROM enquiries e
           LEFT JOIN mobile_discount_offers d ON d.id = e.mobile_discount_offer_id
          WHERE e.id = $1::bigint AND e.guest_id = $2::bigint`,
        [enquiry_id, guest_id]
      );
      if (enquiryDiscount.rows.length) {
        parsedDiscount = Number(enquiryDiscount.rows[0].discount_amount || 0);
        discountReason = enquiryDiscount.rows[0].reason || (parsedDiscount > 0 ? 'Mobile discount offer' : null);
      }
    }

    if (parsedDiscount > 0 && !['SUPER_ADMIN', 'ADMIN'].includes(req.user.role)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, message: 'Only admins can apply booking discounts' });
    }
    if (parsedDiscount > 0 && !discountReason) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'A discount reason is required' });
    }

    if (property.status !== 'ACTIVE') {
      await client.query('ROLLBACK');

      return res.status(409).json({
        success: false,
        message:
          'Property is not currently active'
      });
    }

    const guest = guestResult.rows[0];
    const mobileField = guest.whatsapp_number ? 'whatsapp_number' : 'phone';
    const mobileValidation = validatePhoneNumber(guest[mobileField]);
    if (!mobileValidation.valid) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: INVALID_MOBILE_MESSAGE
      });
    }

    if (guest[mobileField] !== mobileValidation.normalizedNumber) {
      const column = mobileField === 'whatsapp_number' ? 'whatsapp_number' : 'phone';
      await client.query(
        `UPDATE guests SET ${column} = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [mobileValidation.normalizedNumber, guest_id]
      );
    }

    const parsedAdults = Number(adults);
    const parsedChildren = Number(children);
    if (!Number.isInteger(parsedAdults) || parsedAdults < 1 ||
        !Number.isInteger(parsedChildren) || parsedChildren < 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: 'Adults must be at least 1 and guest counts must be whole numbers'
      });
    }

    const totalGuests = parsedAdults + parsedChildren;
    if (property.max_guests && totalGuests > Number(property.max_guests)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: `This property allows a maximum of ${property.max_guests} guests`
      });
    }

    // ==================================================
    // CHECK BOOKING CONFLICT
    // ==================================================

    const bookingConflict =
      await client.query(
        `
        SELECT
          id,
          booking_reference,
          check_in,
          check_out,
          booking_status
        FROM bookings
        WHERE property_id = $1

          AND booking_status IN (
            'HOLD',
            'CONFIRMED',
            'CHECKED_IN'
          )

          AND check_in < $3
          AND check_out > $2

        LIMIT 1
        `,
        [
          property_id,
          check_in,
          check_out
        ]
      );

    if (bookingConflict.rows.length > 0) {
      await client.query('ROLLBACK');

      return res.status(409).json({
        success: false,
        message:
          'Property already has a booking for these dates',
        conflict:
          bookingConflict.rows[0]
      });
    }

    // ==================================================
    // CHECK PROPERTY BLOCK
    // ==================================================

    const blockConflict =
      await client.query(
        `
        SELECT
          id,
          start_date,
          end_date,
          block_type,
          reason
        FROM property_blocks
        WHERE property_id = $1

          AND start_date < $3
          AND end_date > $2

        LIMIT 1
        `,
        [
          property_id,
          check_in,
          check_out
        ]
      );

    if (blockConflict.rows.length > 0) {
      await client.query('ROLLBACK');

      return res.status(409).json({
        success: false,
        message:
          'Property is blocked for these dates',
        conflict:
          blockConflict.rows[0]
      });
    }

    // ==================================================
    // PRICE CALCULATION
    // ==================================================

    const extraGuests = Math.max(0, totalGuests - Number(property.included_guests || 6));
    const calculatedBaseAmount = Number(property.base_price || 0) * nights;
    const extraGuestAmount = extraGuests * Number(property.extra_guest_price || 0) * nights;
    const grossAmount = calculatedBaseAmount + extraGuestAmount + parsedTaxes;
    if (parsedDiscount > grossAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Discount cannot exceed the booking amount' });
    }
    const calculatedTotalAmount = grossAmount - parsedDiscount;

    // ==================================================
    // GENERATE UNIQUE BOOKING REFERENCE
    // ==================================================

    let bookingReference;
    let referenceExists = true;

    while (referenceExists) {
      bookingReference =
        generateBookingReference();

      const referenceCheck =
        await client.query(
          `
          SELECT id
          FROM bookings
          WHERE booking_reference = $1
          `,
          [bookingReference]
        );

      referenceExists =
        referenceCheck.rows.length > 0;
    }

    // ==================================================
    // CREATE BOOKING
    // ==================================================

    const bookingResult =
      await client.query(
        `
        INSERT INTO bookings (
          booking_reference,
          guest_id,
          property_id,
          enquiry_id,

          check_in,
          check_out,

          adults,
          children,
          number_of_nights,

          base_amount,
          taxes,
          discount_amount,
          total_amount,
          discount_reason,
          discount_updated_by,
          discount_updated_at,

          source,

          booking_status,
          payment_status,

          special_requests,

          created_by
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,

          $5,
          $6,

          $7,
          $8,
          $9,

          $10,
          $11,
          $12,
          $13,
          $17,
          CASE WHEN $12::numeric > 0 THEN $16 ELSE NULL END,
          CASE WHEN $12::numeric > 0 THEN CURRENT_TIMESTAMP ELSE NULL END,

          $14,

          'CONFIRMED',
          'PENDING',

          $15,

          $16
        )
        RETURNING *
        `,
        [
          bookingReference,
          guest_id,
          property_id,
          enquiry_id || null,

          check_in,
          check_out,

          Number(adults) || 1,
          Number(children) || 0,
          nights,

          calculatedBaseAmount,
          parsedTaxes,
          parsedDiscount,
          calculatedTotalAmount,

          String(source).toUpperCase(),

          special_requests || null,

          req.user.id,
          discountReason
        ]
      );

    // ==================================================
    // MARK ENQUIRY AS CONVERTED
    // ==================================================

    if (enquiry_id) {
      await client.query(
        `
        UPDATE enquiries
        SET
          status = 'CONVERTED',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        `,
        [enquiry_id]
      );
    }

    await client.query('COMMIT');

    triggerBookingWhatsAppAutomation({
      event: 'BOOKING_REQUEST_RECEIVED',
      bookingId: bookingResult.rows[0].id
    });

    return res.status(201).json({
      success: true,
      message:
        'Booking created successfully',
      booking:
        bookingResult.rows[0]
    });

  } catch (error) {
    await client.query('ROLLBACK');

    console.error(
      'Create booking error:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Unable to create booking',
      error: error.message
    });

  } finally {
    client.release();
  }
};


// ======================================================
// LIST BOOKINGS
// ======================================================

const getBookings = async (req, res) => {
  try {
    const {
      status,
      payment_status,
      property_id,
      search
    } = req.query;

    const values = [];
    const conditions = [];

    if (status) {
      values.push(
        String(status).toUpperCase()
      );

      conditions.push(
        `b.booking_status = $${values.length}`
      );
    }

    if (payment_status) {
      values.push(
        String(payment_status).toUpperCase()
      );

      conditions.push(
        `b.payment_status = $${values.length}`
      );
    }

    if (property_id) {
      values.push(property_id);

      conditions.push(
        `b.property_id = $${values.length}`
      );
    }

    if (search) {
      values.push(
        `%${String(search).toLowerCase()}%`
      );

      conditions.push(`
        (
          LOWER(b.booking_reference)
            LIKE $${values.length}

          OR LOWER(g.full_name)
            LIKE $${values.length}

          OR LOWER(
            COALESCE(g.email, '')
          ) LIKE $${values.length}

          OR LOWER(
            COALESCE(g.phone, '')
          ) LIKE $${values.length}
        )
      `);
    }

    const whereClause =
      conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : '';

    const result = await pool.query(
      `
      SELECT
        b.*,

        g.full_name,
        g.email,
        g.phone,
        g.whatsapp_number,
        g.referral_name,
        g.referral_mobile,

        p.property_code,
        p.property_name,

        u.full_name AS created_by_name

      FROM bookings b

      JOIN guests g
        ON g.id = b.guest_id

      JOIN properties p
        ON p.id = b.property_id

      LEFT JOIN users u
        ON u.id = b.created_by

      ${whereClause}

      ORDER BY
        b.created_at DESC
      `,
      values
    );

    return res.json({
      success: true,
      total: result.rows.length,
      bookings: result.rows
    });

  } catch (error) {
    console.error(
      'Get bookings error:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Unable to load bookings',
      error: error.message
    });
  }
};


// ======================================================
// GET BOOKING BY ID
// ======================================================

const getBookingById = async (
  req,
  res
) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT
        b.*,

        g.full_name,
        g.email,
        g.phone,
        g.whatsapp_number,
        g.referral_name,
        g.referral_mobile,

        p.property_code,
        p.property_name,
        p.address,
        p.area,
        p.city,

        u.full_name AS created_by_name

      FROM bookings b

      JOIN guests g
        ON g.id = b.guest_id

      JOIN properties p
        ON p.id = b.property_id

      LEFT JOIN users u
        ON u.id = b.created_by

      WHERE b.id = $1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message:
          'Booking not found'
      });
    }

    const payments =
      await pool.query(
        `
        SELECT *
        FROM payments
        WHERE booking_id = $1
        ORDER BY created_at DESC
        `,
        [id]
      );

    return res.json({
      success: true,
      booking: result.rows[0],
      payments: payments.rows
    });

  } catch (error) {
    console.error(
      'Get booking error:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Unable to load booking',
      error: error.message
    });
  }
};


// ======================================================
// UPDATE BOOKING STATUS
// ======================================================

const updateBookingStatus = async (
  req,
  res
) => {
  try {
    const { id } = req.params;

    const {
      booking_status
    } = req.body;

    const allowedStatuses = [
      'HOLD',
      'CONFIRMED',
      'CHECKED_IN',
      'CHECKED_OUT',
      'CANCELLED',
      'NO_SHOW'
    ];

    const normalizedStatus =
      String(
        booking_status || ''
      ).toUpperCase();

    if (
      !allowedStatuses.includes(
        normalizedStatus
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Invalid booking status'
      });
    }

    const result = await pool.query(
      `
      UPDATE bookings
      SET
        booking_status = $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
      `,
      [
        normalizedStatus,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message:
          'Booking not found'
      });
    }

    if (normalizedStatus === 'CONFIRMED') {
      triggerBookingWhatsAppAutomation({
        event: 'BOOKING_CONFIRMED',
        bookingId: result.rows[0].id
      });
    } else if (['CANCELLED', 'NO_SHOW'].includes(normalizedStatus)) {
      triggerBookingWhatsAppAutomation({
        event: 'BOOKING_REJECTED',
        bookingId: result.rows[0].id,
        rejectionReason: req.body.rejection_reason
      });
    }

    return res.json({
      success: true,
      message:
        'Booking status updated successfully',
      booking:
        result.rows[0]
    });

  } catch (error) {
    console.error(
      'Update booking status error:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Unable to update booking status',
      error: error.message
    });
  }
};


const updateBookingDiscount = async (req, res) => {
  const client = await pool.connect();
  try {
    const discountAmount = Number(req.body.discount_amount);
    const discountReason = String(req.body.discount_reason || '').trim() || null;
    if (!Number.isFinite(discountAmount) || discountAmount < 0) {
      return res.status(400).json({ success: false, message: 'Discount amount must be a valid non-negative number' });
    }
    if (discountAmount > 0 && !discountReason) {
      return res.status(400).json({ success: false, message: 'A discount reason is required' });
    }

    await client.query('BEGIN');
    const current = await client.query(
      `SELECT *, (COALESCE(total_amount, 0) + COALESCE(discount_amount, 0)) AS gross_amount
         FROM bookings WHERE id = $1::bigint FOR UPDATE`,
      [req.params.id]
    );
    if (!current.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }
    if (discountAmount > Number(current.rows[0].gross_amount)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Discount cannot exceed the booking amount' });
    }

    const result = await client.query(
      `UPDATE bookings
          SET discount_amount = $1,
              discount_reason = $2,
              total_amount = $5::numeric - $1,
              discount_updated_by = $3,
              discount_updated_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $4::bigint RETURNING *`,
      [discountAmount, discountReason, req.user.id, req.params.id, Number(current.rows[0].gross_amount)]
    );
    await client.query('COMMIT');
    return res.json({ success: true, message: discountAmount ? 'Booking discount updated' : 'Booking discount removed', booking: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Update booking discount error:', error);
    return res.status(500).json({ success: false, message: 'Unable to update booking discount', error: error.message });
  } finally {
    client.release();
  }
};

module.exports = {
  createBooking,
  getBookings,
  getBookingById,
  updateBookingStatus,
  updateBookingDiscount
};
