const pool = require('../config/database');

const getDashboardSummary = async (req, res) => {
  try {
    const [
      guestsResult,
      enquiriesResult,
      bookingsResult,
      propertiesResult,
      paymentsResult,
      pendingBalanceResult,
      todayCheckInsResult,
      todayCheckOutsResult,
      upcomingBookingsResult,
      recentEnquiriesResult
    ] = await Promise.all([

      pool.query(`
        SELECT COUNT(*)::int AS total_guests,
          COUNT(*) FILTER (WHERE referral_name IS NOT NULL)::int AS referred_guests,
          COUNT(DISTINCT referral_mobile) FILTER (WHERE referral_mobile IS NOT NULL)::int AS unique_referrers
        FROM guests
      `),

      pool.query(`
        SELECT
          COUNT(*)::int AS total_enquiries,
          COUNT(*) FILTER (
            WHERE status = 'NEW'
          )::int AS new_enquiries,
          COUNT(*) FILTER (
            WHERE status = 'CONVERTED'
          )::int AS converted_enquiries
        FROM enquiries
      `),

      pool.query(`
        SELECT
          COUNT(*)::int AS total_bookings,
          COUNT(*) FILTER (
            WHERE booking_status = 'CONFIRMED'
          )::int AS confirmed_bookings,
          COUNT(*) FILTER (
            WHERE booking_status = 'CHECKED_IN'
          )::int AS checked_in_bookings,
          COUNT(*) FILTER (
            WHERE COALESCE(discount_amount, 0) > 0
              AND booking_status NOT IN ('CANCELLED', 'NO_SHOW')
          )::int AS discounted_bookings,
          COALESCE(SUM(discount_amount) FILTER (
            WHERE booking_status NOT IN ('CANCELLED', 'NO_SHOW')
          ), 0) AS total_discounts
        FROM bookings
      `),

      pool.query(`
        SELECT
          COUNT(*)::int AS total_properties,
          COUNT(*) FILTER (
            WHERE status = 'ACTIVE'
          )::int AS active_properties
        FROM properties
      `),

      pool.query(`
        SELECT
          COALESCE(
            SUM(amount) FILTER (
              WHERE payment_status = 'PAID'
            ),
            0
          ) AS total_received
        FROM payments
      `),

      pool.query(`
        SELECT
          COALESCE(
            SUM(
              GREATEST(
                b.total_amount -
                COALESCE(p.total_paid, 0),
                0
              )
            ),
            0
          ) AS pending_balance
        FROM bookings b
        LEFT JOIN (
          SELECT
            booking_id,
            SUM(amount) AS total_paid
          FROM payments
          WHERE payment_status = 'PAID'
          GROUP BY booking_id
        ) p
          ON p.booking_id = b.id
        WHERE b.booking_status NOT IN (
          'CANCELLED',
          'NO_SHOW'
        )
      `),

      pool.query(`
        SELECT
          b.id,
          b.booking_reference,
          b.check_in,
          b.check_out,
          g.full_name,
          g.phone,
          p.property_name,
          p.property_code
        FROM bookings b
        JOIN guests g
          ON g.id = b.guest_id
        JOIN properties p
          ON p.id = b.property_id
        WHERE b.check_in = CURRENT_DATE
          AND b.booking_status IN (
            'CONFIRMED',
            'CHECKED_IN'
          )
        ORDER BY b.check_in ASC
      `),

      pool.query(`
        SELECT
          b.id,
          b.booking_reference,
          b.check_in,
          b.check_out,
          g.full_name,
          g.phone,
          p.property_name,
          p.property_code
        FROM bookings b
        JOIN guests g
          ON g.id = b.guest_id
        JOIN properties p
          ON p.id = b.property_id
        WHERE b.check_out = CURRENT_DATE
          AND b.booking_status IN (
            'CONFIRMED',
            'CHECKED_IN'
          )
        ORDER BY b.check_out ASC
      `),

      pool.query(`
        SELECT
          b.id,
          b.booking_reference,
          b.check_in,
          b.check_out,
          b.booking_status,
          b.payment_status,
          b.base_amount,
          b.taxable_amount,
          b.gst_rate,
          b.cgst_amount,
          b.sgst_amount,
          b.igst_amount,
          b.gst_amount,
          b.currency,
          b.price_includes_gst,
          b.total_amount,
          b.discount_amount,
          b.discount_reason,
          b.adults,
          b.children,
          g.full_name,
          g.phone,
          p.property_name,
          p.property_code
        FROM bookings b
        JOIN guests g
          ON g.id = b.guest_id
        JOIN properties p
          ON p.id = b.property_id
        WHERE b.check_in >= CURRENT_DATE
          AND b.booking_status IN (
            'HOLD',
            'CONFIRMED'
          )
        ORDER BY b.check_in ASC
        LIMIT 10
      `),

      pool.query(`
        SELECT
          e.id,
          e.status,
          e.source,
          e.check_in,
          e.check_out,
          e.adults,
          e.children,
          e.infants,
          e.pets,
          e.original_amount,
          e.quoted_base_amount,
          e.extra_guest_amount,
          e.discount_percentage,
          e.discount_amount,
          e.taxable_amount,
          e.gst_rate,
          e.cgst_amount,
          e.sgst_amount,
          e.igst_amount,
          e.gst_amount,
          e.currency,
          e.price_includes_gst,
          e.quoted_total_amount,
          e.document_type,
          e.document_verification_status,
          CASE
            WHEN e.document_path IS NOT NULL
            THEN '/api/enquiries/' || e.id || '/document'
            ELSE NULL
          END AS document_url,
          e.created_at,
          g.full_name,
          g.email,
          g.phone,
          g.referral_name,
          g.referral_mobile,
          p.property_name,
          p.property_code
        FROM enquiries e
        JOIN guests g
          ON g.id = e.guest_id
        LEFT JOIN properties p
          ON p.id = e.property_id
        ORDER BY e.created_at DESC
        LIMIT 10
      `)
    ]);

    return res.json({
      success: true,

      summary: {
        guests:
          guestsResult.rows[0],

        enquiries:
          enquiriesResult.rows[0],

        bookings:
          bookingsResult.rows[0],

        properties:
          propertiesResult.rows[0],

        revenue: {
          total_received:
            Number(
              paymentsResult.rows[0]
                .total_received || 0
            ),

          pending_balance:
            Number(
              pendingBalanceResult.rows[0]
                .pending_balance || 0
            )
        }
      },

      today: {
        check_ins:
          todayCheckInsResult.rows,

        check_outs:
          todayCheckOutsResult.rows
      },

      upcoming_bookings:
        upcomingBookingsResult.rows,

      recent_enquiries:
        recentEnquiriesResult.rows
    });

  } catch (error) {
    console.error(
      'Dashboard summary error:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Unable to load dashboard',
      error: error.message
    });
  }
};


const getRevenueSummary = async (
  req,
  res
) => {
  try {
    const result = await pool.query(`
      SELECT
        DATE_TRUNC(
          'month',
          paid_at
        ) AS month,

        SUM(amount) AS revenue

      FROM payments

      WHERE payment_status = 'PAID'
        AND paid_at IS NOT NULL

      GROUP BY
        DATE_TRUNC(
          'month',
          paid_at
        )

      ORDER BY month ASC
    `);

    return res.json({
      success: true,

      revenue:
        result.rows.map(row => ({
          month: row.month,
          revenue:
            Number(row.revenue || 0)
        }))
    });

  } catch (error) {
    console.error(
      'Revenue summary error:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Unable to load revenue summary',
      error: error.message
    });
  }
};


const getPropertyOccupancy = async (
  req,
  res
) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id,
        p.property_code,
        p.property_name,
        p.status,

        COUNT(
          b.id
        ) FILTER (
          WHERE
            b.booking_status IN (
              'HOLD',
              'CONFIRMED',
              'CHECKED_IN'
            )
            AND b.check_out >= CURRENT_DATE
        )::int AS active_booking_count,

        MIN(
          b.check_in
        ) FILTER (
          WHERE
            b.booking_status IN (
              'HOLD',
              'CONFIRMED'
            )
            AND b.check_in >= CURRENT_DATE
        ) AS next_check_in

      FROM properties p

      LEFT JOIN bookings b
        ON b.property_id = p.id

      GROUP BY
        p.id,
        p.property_code,
        p.property_name,
        p.status

      ORDER BY
        p.property_name ASC
    `);

    return res.json({
      success: true,
      properties: result.rows
    });

  } catch (error) {
    console.error(
      'Property occupancy error:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Unable to load property occupancy',
      error: error.message
    });
  }
};

const getDashboardAnalytics = async (req, res) => {
  try {
    const requestedMonths = Number.parseInt(req.query.months, 10);
    const months = Number.isInteger(requestedMonths)
      ? Math.min(Math.max(requestedMonths, 1), 24)
      : 12;
    const requestedDays = Number.parseInt(req.query.days, 10);
    const days = Number.isInteger(requestedDays)
      ? Math.min(Math.max(requestedDays, 1), 90)
      : 7;

    const [
      kpisResult,
      recentKpisResult,
      dailyPipelineResult,
      periodFunnelResult,
      bookingStatusResult,
      enquiryStatusResult,
      enquirySourceResult,
      monthlyResult,
      propertyResult,
      cityResult,
      usersResult
    ] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM guests) AS total_guests,
          (SELECT COUNT(*)::int FROM properties WHERE status = 'ACTIVE') AS active_properties,
          (SELECT COUNT(*)::int FROM enquiries) AS total_enquiries,
          (SELECT COUNT(*)::int FROM enquiries WHERE status = 'CONVERTED') AS converted_enquiries,
          (SELECT COUNT(*)::int FROM bookings) AS total_bookings,
          (SELECT COUNT(*)::int FROM bookings WHERE booking_status IN ('CONFIRMED', 'CHECKED_IN')) AS active_bookings,
          (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE payment_status = 'PAID') AS total_revenue,
          (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE payment_status = 'PAID' AND paid_at >= DATE_TRUNC('month', CURRENT_DATE)) AS current_month_revenue,
          (SELECT COALESCE(AVG(total_amount), 0) FROM bookings WHERE booking_status NOT IN ('CANCELLED', 'NO_SHOW')) AS average_booking_value,
          (SELECT COALESCE(SUM(GREATEST(check_out - check_in, 0)), 0)::int FROM bookings WHERE booking_status NOT IN ('CANCELLED', 'NO_SHOW')) AS booked_nights,
          (SELECT COUNT(*)::int FROM guests WHERE referral_name IS NOT NULL) AS referred_guests,
          (SELECT COUNT(DISTINCT referral_mobile)::int FROM guests WHERE referral_mobile IS NOT NULL) AS unique_referrers,
          (SELECT COUNT(*)::int FROM bookings WHERE COALESCE(discount_amount, 0) > 0 AND booking_status NOT IN ('CANCELLED', 'NO_SHOW')) AS discounted_bookings,
          (SELECT COALESCE(SUM(discount_amount), 0) FROM bookings WHERE booking_status NOT IN ('CANCELLED', 'NO_SHOW')) AS total_discounts,
          (SELECT COUNT(*)::int FROM mobile_discount_offers
            WHERE status = 'ACTIVE' AND valid_from <= CURRENT_TIMESTAMP
              AND (valid_until IS NULL OR valid_until > CURRENT_TIMESTAMP)) AS active_mobile_discounts
      `),
      pool.query(`
        SELECT
          (SELECT COUNT(*)::int
             FROM enquiries
            WHERE created_at >= CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day')) AS enquiries_received,
          (SELECT COUNT(*)::int
             FROM enquiries
            WHERE created_at >= CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day')
              AND status = 'CONVERTED') AS enquiries_converted,
          (SELECT COUNT(*)::int
             FROM bookings
            WHERE created_at >= CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day')) AS bookings_created,
          (SELECT COUNT(*)::int
             FROM bookings
            WHERE created_at >= CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day')
              AND booking_status IN ('CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT')) AS bookings_confirmed,
          (SELECT COALESCE(SUM(amount), 0)
             FROM payments
            WHERE payment_status = 'PAID'
              AND paid_at >= CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day')) AS revenue_received,
          (SELECT COUNT(*)::int
             FROM properties
            WHERE status = 'ACTIVE') AS active_properties,
          (SELECT COUNT(DISTINCT property_id)::int
             FROM bookings b
             JOIN properties p ON p.id = b.property_id
            WHERE p.status = 'ACTIVE'
              AND b.booking_status IN ('CONFIRMED', 'CHECKED_IN')
              AND b.check_in <= CURRENT_DATE
              AND b.check_out > CURRENT_DATE) AS occupied_properties
      `, [days]),
      pool.query(`
        WITH date_range AS (
          SELECT generate_series(
            CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day'),
            CURRENT_DATE,
            INTERVAL '1 day'
          )::date AS date
        ), enquiry_totals AS (
          SELECT created_at::date AS date,
                 COUNT(*)::int AS received,
                 COUNT(*) FILTER (WHERE status = 'CONVERTED')::int AS converted,
                 COUNT(*) FILTER (WHERE status IN ('LOST', 'CANCELLED'))::int AS lost
            FROM enquiries
           WHERE created_at >= CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day')
           GROUP BY created_at::date
        ), booking_totals AS (
          SELECT created_at::date AS date,
                 COUNT(*)::int AS bookings
            FROM bookings
           WHERE created_at >= CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day')
           GROUP BY created_at::date
        )
        SELECT d.date,
               COALESCE(e.received, 0)::int AS enquiries_received,
               COALESCE(e.converted, 0)::int AS enquiries_converted,
               COALESCE(e.lost, 0)::int AS enquiries_lost,
               COALESCE(b.bookings, 0)::int AS bookings_created
          FROM date_range d
          LEFT JOIN enquiry_totals e ON e.date = d.date
          LEFT JOIN booking_totals b ON b.date = d.date
         ORDER BY d.date
      `, [days]),
      pool.query(`
        SELECT status, COUNT(*)::int AS count
          FROM enquiries
         WHERE created_at >= CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day')
         GROUP BY status
         ORDER BY count DESC, status
      `, [days]),
      pool.query(`
        SELECT booking_status AS status, COUNT(*)::int AS count
        FROM bookings GROUP BY booking_status ORDER BY booking_status
      `),
      pool.query(`
        SELECT status, COUNT(*)::int AS count
        FROM enquiries GROUP BY status ORDER BY status
      `),
      pool.query(`
        SELECT COALESCE(source, 'UNKNOWN') AS source, COUNT(*)::int AS count
        FROM enquiries GROUP BY COALESCE(source, 'UNKNOWN') ORDER BY count DESC
      `),
      pool.query(`
        WITH months AS (
          SELECT generate_series(
            DATE_TRUNC('month', CURRENT_DATE) - (($1::int - 1) * INTERVAL '1 month'),
            DATE_TRUNC('month', CURRENT_DATE),
            INTERVAL '1 month'
          ) AS month
        ), booking_totals AS (
          SELECT DATE_TRUNC('month', created_at) AS month,
                 COUNT(*)::int AS bookings,
                 COALESCE(SUM(total_amount), 0) AS booking_value
          FROM bookings
          WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE) - (($1::int - 1) * INTERVAL '1 month')
          GROUP BY 1
        ), payment_totals AS (
          SELECT DATE_TRUNC('month', paid_at) AS month,
                 COALESCE(SUM(amount), 0) AS revenue
          FROM payments
          WHERE payment_status = 'PAID'
            AND paid_at >= DATE_TRUNC('month', CURRENT_DATE) - (($1::int - 1) * INTERVAL '1 month')
          GROUP BY 1
        )
        SELECT m.month,
               COALESCE(bt.bookings, 0)::int AS bookings,
               COALESCE(bt.booking_value, 0) AS booking_value,
               COALESCE(pt.revenue, 0) AS revenue
        FROM months m
        LEFT JOIN booking_totals bt ON bt.month = m.month
        LEFT JOIN payment_totals pt ON pt.month = m.month
        ORDER BY m.month
      `, [months]),
      pool.query(`
        SELECT p.id, p.property_code, p.property_name, p.status,
               p.city,
               COUNT(b.id)::int AS total_bookings,
               COUNT(b.id) FILTER (WHERE b.booking_status IN ('CONFIRMED', 'CHECKED_IN'))::int AS active_bookings,
               COALESCE(SUM(b.total_amount) FILTER (WHERE b.booking_status NOT IN ('CANCELLED', 'NO_SHOW')), 0) AS booking_value,
               COALESCE(SUM(pay.paid_amount), 0) AS revenue,
               COALESCE(SUM(GREATEST(b.check_out - b.check_in, 0)) FILTER (WHERE b.booking_status NOT IN ('CANCELLED', 'NO_SHOW')), 0)::int AS booked_nights
        FROM properties p
        LEFT JOIN bookings b ON b.property_id = p.id
        LEFT JOIN (
          SELECT booking_id, SUM(amount) AS paid_amount
          FROM payments WHERE payment_status = 'PAID' GROUP BY booking_id
        ) pay ON pay.booking_id = b.id
        GROUP BY p.id, p.property_code, p.property_name, p.status
        ORDER BY revenue DESC, p.property_name
      `),
      pool.query(`
        SELECT COALESCE(NULLIF(TRIM(p.city), ''), 'Unknown') AS city,
               COUNT(DISTINCT p.id)::int AS properties,
               COUNT(b.id)::int AS bookings,
               COALESCE(SUM(b.total_amount) FILTER (
                 WHERE b.booking_status NOT IN ('CANCELLED', 'NO_SHOW')
               ), 0) AS booking_value,
               COALESCE(SUM(pay.paid_amount), 0) AS revenue
          FROM properties p
          LEFT JOIN bookings b ON b.property_id = p.id
          LEFT JOIN (
            SELECT booking_id, SUM(amount) AS paid_amount
              FROM payments
             WHERE payment_status = 'PAID'
             GROUP BY booking_id
          ) pay ON pay.booking_id = b.id
         GROUP BY COALESCE(NULLIF(TRIM(p.city), ''), 'Unknown')
         ORDER BY revenue DESC, bookings DESC, city
      `),
      pool.query(`
        SELECT role, status, COUNT(*)::int AS count
        FROM users GROUP BY role, status ORDER BY role, status
      `)
    ]);

    const kpis = kpisResult.rows[0];
    const recentKpis = recentKpisResult.rows[0];
    const totalEnquiries = Number(kpis.total_enquiries || 0);
    const convertedEnquiries = Number(kpis.converted_enquiries || 0);
    const recentEnquiries = Number(recentKpis.enquiries_received || 0);
    const recentConversions = Number(recentKpis.enquiries_converted || 0);
    const activeProperties = Number(recentKpis.active_properties || 0);
    const occupiedProperties = Number(recentKpis.occupied_properties || 0);

    return res.json({
      success: true,
      generated_at: new Date().toISOString(),
      period: { days, months },
      overview: {
        enquiries_received: recentEnquiries,
        enquiries_converted: recentConversions,
        bookings_created: Number(recentKpis.bookings_created || 0),
        bookings_confirmed: Number(recentKpis.bookings_confirmed || 0),
        revenue_received: Number(recentKpis.revenue_received || 0),
        conversion_rate: recentEnquiries > 0
          ? Number(((recentConversions / recentEnquiries) * 100).toFixed(2))
          : 0,
        active_properties: activeProperties,
        occupied_properties: occupiedProperties,
        occupancy_rate: activeProperties > 0
          ? Number(((occupiedProperties / activeProperties) * 100).toFixed(2))
          : 0
      },
      daily_pipeline: dailyPipelineResult.rows,
      period_enquiry_funnel: periodFunnelResult.rows,
      kpis: {
        ...kpis,
        total_revenue: Number(kpis.total_revenue || 0),
        current_month_revenue: Number(kpis.current_month_revenue || 0),
        average_booking_value: Number(kpis.average_booking_value || 0),
        total_discounts: Number(kpis.total_discounts || 0),
        enquiry_conversion_rate: totalEnquiries > 0
          ? Number(((convertedEnquiries / totalEnquiries) * 100).toFixed(2))
          : 0
      },
      booking_status_breakdown: bookingStatusResult.rows,
      enquiry_funnel: enquiryStatusResult.rows,
      enquiry_sources: enquirySourceResult.rows,
      monthly_trends: monthlyResult.rows.map(row => ({
        ...row,
        booking_value: Number(row.booking_value || 0),
        revenue: Number(row.revenue || 0)
      })),
      property_performance: propertyResult.rows.map(row => ({
        ...row,
        booking_value: Number(row.booking_value || 0),
        revenue: Number(row.revenue || 0)
      })),
      city_performance: cityResult.rows.map(row => ({
        ...row,
        booking_value: Number(row.booking_value || 0),
        revenue: Number(row.revenue || 0)
      })),
      user_breakdown: usersResult.rows
    });
  } catch (error) {
    console.error('Dashboard analytics error:', error);
    return res.status(500).json({
      success: false,
      message: 'Unable to load dashboard analytics',
      error: error.message
    });
  }
};


module.exports = {
  getDashboardSummary,
  getRevenueSummary,
  getPropertyOccupancy,
  getDashboardAnalytics
};
