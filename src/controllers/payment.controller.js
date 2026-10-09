const pool = require('../config/database');
const {
  triggerBookingWhatsAppAutomation
} = require('../services/whatsapp.service');

const allowedStatuses = [
  'PENDING',
  'PAID',
  'FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED'
];


// ======================================================
// CREATE PAYMENT
// ======================================================

const createPayment = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      booking_id,
      guest_id,
      amount,
      payment_method,
      payment_gateway,
      gateway_order_id,
      gateway_payment_id,
      gateway_signature,
      payment_link,
      payment_status = 'PAID'
    } = req.body;

    if (!booking_id || !amount) {
      return res.status(400).json({
        success: false,
        message: 'booking_id and amount are required'
      });
    }

    const normalizedStatus =
      String(payment_status).toUpperCase();

    if (!allowedStatuses.includes(normalizedStatus)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment status'
      });
    }

    await client.query('BEGIN');

    // ==================================================
    // CHECK BOOKING
    // ==================================================

    const bookingResult = await client.query(
      `
      SELECT *
      FROM bookings
      WHERE id = $1
      `,
      [booking_id]
    );

    if (bookingResult.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    const booking = bookingResult.rows[0];

    const finalGuestId =
      guest_id || booking.guest_id;

    // ==================================================
    // DETERMINE PAID DATE
    // ==================================================

    const paidAt =
      normalizedStatus === 'PAID'
        ? new Date()
        : null;

    // ==================================================
    // CREATE PAYMENT
    // ==================================================

    const paymentResult = await client.query(
      `
      INSERT INTO payments (
        booking_id,
        guest_id,
        amount,
        payment_method,
        payment_gateway,
        gateway_order_id,
        gateway_payment_id,
        gateway_signature,
        payment_status,
        paid_at
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10
      )
      RETURNING *
      `,
      [
        booking_id,
        finalGuestId,
        amount,
        payment_method || null,
        payment_gateway || null,
        gateway_order_id || null,
        gateway_payment_id || null,
        gateway_signature || null,
        normalizedStatus,
        paidAt
      ]
    );

    // ==================================================
    // CALCULATE TOTAL PAID
    // ==================================================

    const paidResult = await client.query(
      `
      SELECT
        COALESCE(SUM(amount), 0) AS paid_amount
      FROM payments
      WHERE booking_id = $1
        AND payment_status = 'PAID'
      `,
      [booking_id]
    );

    const paidAmount =
      Number(
        paidResult.rows[0].paid_amount || 0
      );

    const totalAmount =
      Number(
        booking.total_amount || 0
      );

    let bookingPaymentStatus = 'PENDING';

    if (
      paidAmount >= totalAmount &&
      totalAmount > 0
    ) {
      bookingPaymentStatus = 'PAID';

    } else if (paidAmount > 0) {
      bookingPaymentStatus = 'PARTIALLY_PAID';
    }

    // ==================================================
    // UPDATE BOOKING PAYMENT STATUS
    // ==================================================

    await client.query(
      `
      UPDATE bookings
      SET
        payment_status = $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      `,
      [
        bookingPaymentStatus,
        booking_id
      ]
    );

    await client.query('COMMIT');

    if (payment_link) {
      triggerBookingWhatsAppAutomation({
        event: 'PAYMENT_LINK_CREATED',
        bookingId: booking_id,
        amount,
        paymentLink: payment_link
      });
    }

    if (normalizedStatus === 'PAID') {
      triggerBookingWhatsAppAutomation({
        event: 'PAYMENT_SUCCESS',
        bookingId: booking_id,
        amount
      });
    } else if (normalizedStatus === 'FAILED') {
      triggerBookingWhatsAppAutomation({
        event: 'PAYMENT_FAILED',
        bookingId: booking_id,
        amount
      });
    }

    if (bookingPaymentStatus === 'PAID' && booking.payment_status !== 'PAID') {
      triggerBookingWhatsAppAutomation({
        event: 'BOOKING_CONFIRMED',
        bookingId: booking_id
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Payment recorded successfully',

      payment: paymentResult.rows[0],

      payment_summary: {
        total_amount: totalAmount,
        paid_amount: paidAmount,
        balance_amount:
          Math.max(
            totalAmount - paidAmount,
            0
          ),
        payment_status:
          bookingPaymentStatus
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');

    console.error(
      'Create payment error:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Unable to record payment',
      error: error.message
    });

  } finally {
    client.release();
  }
};


// ======================================================
// GET ALL PAYMENTS
// ======================================================

const getPayments = async (req, res) => {
  try {
    const {
      booking_id,
      payment_status
    } = req.query;

    const values = [];
    const conditions = [];

    if (booking_id) {
      values.push(booking_id);

      conditions.push(
        `p.booking_id = $${values.length}`
      );
    }

    if (payment_status) {
      values.push(
        String(payment_status).toUpperCase()
      );

      conditions.push(
        `p.payment_status = $${values.length}`
      );
    }

    const whereClause =
      conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : '';

    const result = await pool.query(
      `
      SELECT
        p.*,

        b.booking_reference,
        b.total_amount,

        g.full_name,
        g.email,
        g.phone

      FROM payments p

      JOIN bookings b
        ON b.id = p.booking_id

      LEFT JOIN guests g
        ON g.id = p.guest_id

      ${whereClause}

      ORDER BY
        p.created_at DESC
      `,
      values
    );

    return res.json({
      success: true,
      total: result.rows.length,
      payments: result.rows
    });

  } catch (error) {
    console.error(
      'Get payments error:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Unable to load payments',
      error: error.message
    });
  }
};


// ======================================================
// GET PAYMENT BY ID
// ======================================================

const getPaymentById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT
        p.*,

        b.booking_reference,
        b.total_amount,

        g.full_name,
        g.email,
        g.phone

      FROM payments p

      JOIN bookings b
        ON b.id = p.booking_id

      LEFT JOIN guests g
        ON g.id = p.guest_id

      WHERE p.id = $1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    return res.json({
      success: true,
      payment: result.rows[0]
    });

  } catch (error) {
    console.error(
      'Get payment error:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Unable to load payment',
      error: error.message
    });
  }
};


// ======================================================
// UPDATE PAYMENT STATUS
// ======================================================

const updatePaymentStatus = async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    const {
      payment_status
    } = req.body;

    const normalizedStatus =
      String(
        payment_status || ''
      ).toUpperCase();

    if (
      !allowedStatuses.includes(
        normalizedStatus
      )
    ) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment status'
      });
    }

    await client.query('BEGIN');

    // ==================================================
    // UPDATE PAYMENT
    // ==================================================

    const paidAt =
      normalizedStatus === 'PAID'
        ? new Date()
        : null;

    const paymentResult = await client.query(
      `
      UPDATE payments
      SET
        payment_status = $1,
        paid_at = $2,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
      `,
      [
        normalizedStatus,
        paidAt,
        id
      ]
    );

    if (paymentResult.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    const payment =
      paymentResult.rows[0];

    // ==================================================
    // GET BOOKING
    // ==================================================

    const bookingResult = await client.query(
      `
      SELECT *
      FROM bookings
      WHERE id = $1
      `,
      [
        payment.booking_id
      ]
    );

    if (bookingResult.rows.length === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    const booking =
      bookingResult.rows[0];

    // ==================================================
    // CALCULATE TOTAL PAID
    // ==================================================

    const paidResult = await client.query(
      `
      SELECT
        COALESCE(
          SUM(amount),
          0
        ) AS paid_amount
      FROM payments
      WHERE booking_id = $1
        AND payment_status = 'PAID'
      `,
      [
        payment.booking_id
      ]
    );

    const paidAmount =
      Number(
        paidResult.rows[0].paid_amount || 0
      );

    const totalAmount =
      Number(
        booking.total_amount || 0
      );

    let bookingPaymentStatus =
      'PENDING';

    if (
      paidAmount >= totalAmount &&
      totalAmount > 0
    ) {
      bookingPaymentStatus =
        'PAID';

    } else if (paidAmount > 0) {
      bookingPaymentStatus =
        'PARTIALLY_PAID';
    }

    // ==================================================
    // UPDATE BOOKING PAYMENT STATUS
    // ==================================================

    await client.query(
      `
      UPDATE bookings
      SET
        payment_status = $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      `,
      [
        bookingPaymentStatus,
        payment.booking_id
      ]
    );

    await client.query('COMMIT');

    if (normalizedStatus === 'PAID') {
      triggerBookingWhatsAppAutomation({
        event: 'PAYMENT_SUCCESS',
        bookingId: payment.booking_id,
        amount: payment.amount
      });
    } else if (normalizedStatus === 'FAILED') {
      triggerBookingWhatsAppAutomation({
        event: 'PAYMENT_FAILED',
        bookingId: payment.booking_id,
        amount: payment.amount
      });
    }

    if (bookingPaymentStatus === 'PAID' && booking.payment_status !== 'PAID') {
      triggerBookingWhatsAppAutomation({
        event: 'BOOKING_CONFIRMED',
        bookingId: payment.booking_id
      });
    }

    return res.json({
      success: true,
      message:
        'Payment status updated successfully',

      payment,

      payment_summary: {
        total_amount:
          totalAmount,

        paid_amount:
          paidAmount,

        balance_amount:
          Math.max(
            totalAmount - paidAmount,
            0
          ),

        payment_status:
          bookingPaymentStatus
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');

    console.error(
      'Update payment status error:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Unable to update payment',
      error: error.message
    });

  } finally {
    client.release();
  }
};


module.exports = {
  createPayment,
  getPayments,
  getPaymentById,
  updatePaymentStatus
};
