const fs = require('fs');
const path = require('path');
const pool = require('../config/database');
const { sendEmail } = require('../services/mail.service');
const {
  triggerEnquiryWhatsAppAutomation,
  sendWhatsAppAutomation
} = require('../services/whatsapp.service');
const {
  ALLOWED_STATUSES,
  EnquiryTransitionError,
  validateGenericTransition,
  validateApproval
} = require('../services/enquiryWorkflow.service');

const ALLOWED_SOURCES = [
  'WEBSITE',
  'TG-0001',
  'WHATSAPP',
  'REFERRAL',
  'INSTAGRAM',
  'PHONE',
  'AIRBNB',
  'WALK_IN',
  'OTHER'
];

// ======================================================
// PUBLIC WEBSITE ENQUIRY
// Creates/reuses guest + creates enquiry
// ======================================================

const createPublicEnquiry = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      full_name,
      email,
      phone,
      whatsapp_number,
      city,
      property_id,
      check_in,
      check_out,
      adults = 1,
      children = 0,
      guest_message
    } = req.body;

    if (!full_name) {
      return res.status(400).json({
        success: false,
        message: 'Full name is required'
      });
    }

    if (!email && !phone && !whatsapp_number) {
      return res.status(400).json({
        success: false,
        message: 'Email, phone or WhatsApp number is required'
      });
    }

    if (check_in && check_out) {
      const checkInDate = new Date(check_in);
      const checkOutDate = new Date(check_out);

      if (checkOutDate <= checkInDate) {
        return res.status(400).json({
          success: false,
          message: 'Check-out date must be after check-in date'
        });
      }
    }

    const normalizedEmail = email
      ? email.trim().toLowerCase()
      : null;

    await client.query('BEGIN');

    // --------------------------------------------------
    // FIND EXISTING GUEST
    // --------------------------------------------------

    const existingGuest = await client.query(
      `
      SELECT *
      FROM guests
      WHERE
        ($1::text IS NOT NULL AND LOWER(email) = LOWER($1))
        OR
        ($2::text IS NOT NULL AND phone = $2)
        OR
        ($3::text IS NOT NULL AND whatsapp_number = $3)
      ORDER BY id ASC
      LIMIT 1
      `,
      [
        normalizedEmail,
        phone || null,
        whatsapp_number || null
      ]
    );

    let guest;

    if (existingGuest.rows.length > 0) {
      guest = existingGuest.rows[0];

      const updatedGuest = await client.query(
        `
        UPDATE guests
        SET
          full_name = COALESCE($1, full_name),
          email = COALESCE($2, email),
          phone = COALESCE($3, phone),
          whatsapp_number = COALESCE($4, whatsapp_number),
          city = COALESCE($5, city),
          last_contact_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $6
        RETURNING *
        `,
        [
          full_name.trim(),
          normalizedEmail,
          phone || null,
          whatsapp_number || null,
          city || null,
          guest.id
        ]
      );

      guest = updatedGuest.rows[0];

    } else {
      const newGuest = await client.query(
        `
        INSERT INTO guests (
          full_name,
          email,
          phone,
          whatsapp_number,
          city,
          country,
          source,
          first_enquiry_at,
          last_contact_at,
          guest_status
        )
        VALUES (
          $1, $2, $3, $4, $5,
          'India',
          'WEBSITE',
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP,
          'ACTIVE'
        )
        RETURNING *
        `,
        [
          full_name.trim(),
          normalizedEmail,
          phone || null,
          whatsapp_number || null,
          city || null
        ]
      );

      guest = newGuest.rows[0];
    }

    // --------------------------------------------------
    // CREATE ENQUIRY
    // --------------------------------------------------

    const enquiryResult = await client.query(
      `
      INSERT INTO enquiries (
        guest_id,
        property_id,
        source,
        check_in,
        check_out,
        adults,
        children,
        guest_message,
        status
      )
      VALUES (
        $1, $2, 'WEBSITE', $3, $4, $5, $6, $7, 'NEW'
      )
      RETURNING *
      `,
      [
        guest.id,
        property_id || null,
        check_in || null,
        check_out || null,
        Number(adults) || 1,
        Number(children) || 0,
        guest_message || null
      ]
    );

    await client.query('COMMIT');

    triggerEnquiryWhatsAppAutomation({
      event: 'BOOKING_REQUEST_RECEIVED',
      enquiryId: enquiryResult.rows[0].id
    });

    return res.status(201).json({
      success: true,
      message: 'Enquiry submitted successfully',
      guest,
      enquiry: enquiryResult.rows[0]
    });

  } catch (error) {
    await client.query('ROLLBACK');

    console.error('Create public enquiry error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to submit enquiry',
      error: error.message
    });

  } finally {
    client.release();
  }
};


// ======================================================
// INTERNAL CREATE ENQUIRY
// Used for WhatsApp / referral / phone / etc.
// ======================================================

const createEnquiry = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      guest_id,
      full_name,
      email,
      phone,
      whatsapp_number,
      city,

      property_id,

      source = 'OTHER',

      check_in,
      check_out,

      adults = 1,
      children = 0,

      guest_message,

      quoted_amount,

      assigned_to
    } = req.body;

    const normalizedSource = String(source).toUpperCase();

    if (!ALLOWED_SOURCES.includes(normalizedSource)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid enquiry source'
      });
    }

    if (check_in && check_out) {
      if (new Date(check_out) <= new Date(check_in)) {
        return res.status(400).json({
          success: false,
          message: 'Check-out date must be after check-in date'
        });
      }
    }

    await client.query('BEGIN');

    let guest;

    // --------------------------------------------------
    // EXISTING GUEST ID PROVIDED
    // --------------------------------------------------

    if (guest_id) {
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

      guest = guestResult.rows[0];

    } else {
      // ------------------------------------------------
      // CREATE OR FIND GUEST
      // ------------------------------------------------

      if (!full_name) {
        await client.query('ROLLBACK');

        return res.status(400).json({
          success: false,
          message: 'Guest name is required'
        });
      }

      const normalizedEmail = email
        ? email.trim().toLowerCase()
        : null;

      const existingGuest = await client.query(
        `
        SELECT *
        FROM guests
        WHERE
          ($1::text IS NOT NULL AND LOWER(email) = LOWER($1))
          OR
          ($2::text IS NOT NULL AND phone = $2)
          OR
          ($3::text IS NOT NULL AND whatsapp_number = $3)
        LIMIT 1
        `,
        [
          normalizedEmail,
          phone || null,
          whatsapp_number || null
        ]
      );

      if (existingGuest.rows.length > 0) {
        guest = existingGuest.rows[0];

      } else {
        const newGuest = await client.query(
          `
          INSERT INTO guests (
            full_name,
            email,
            phone,
            whatsapp_number,
            city,
            country,
            source,
            first_enquiry_at,
            last_contact_at,
            guest_status
          )
          VALUES (
            $1, $2, $3, $4, $5,
            'India',
            $6,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP,
            'ACTIVE'
          )
          RETURNING *
          `,
          [
            full_name.trim(),
            normalizedEmail,
            phone || null,
            whatsapp_number || null,
            city || null,
            normalizedSource
          ]
        );

        guest = newGuest.rows[0];
      }
    }

    // --------------------------------------------------
    // CREATE ENQUIRY
    // --------------------------------------------------

    const enquiryResult = await client.query(
      `
      INSERT INTO enquiries (
        guest_id,
        property_id,
        source,
        check_in,
        check_out,
        adults,
        children,
        guest_message,
        quoted_amount,
        status,
        assigned_to
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        'NEW',
        $10
      )
      RETURNING *
      `,
      [
        guest.id,
        property_id || null,
        normalizedSource,
        check_in || null,
        check_out || null,
        Number(adults) || 1,
        Number(children) || 0,
        guest_message || null,
        quoted_amount || null,
        assigned_to || null
      ]
    );

    await client.query('COMMIT');

    triggerEnquiryWhatsAppAutomation({
      event: 'BOOKING_REQUEST_RECEIVED',
      enquiryId: enquiryResult.rows[0].id
    });

    return res.status(201).json({
      success: true,
      message: 'Enquiry created successfully',
      guest,
      enquiry: enquiryResult.rows[0]
    });

  } catch (error) {
    await client.query('ROLLBACK');

    console.error('Create enquiry error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to create enquiry',
      error: error.message
    });

  } finally {
    client.release();
  }
};


// ======================================================
// LIST ENQUIRIES
// ======================================================

const getEnquiries = async (req, res) => {
  try {
    const {
      status,
      source,
      property_id,
      search,
      application_only
    } = req.query;

    const values = [];
    const conditions = [];

    if (String(application_only).toLowerCase() === 'true') {
      conditions.push(`e.source IN ('WEBSITE', 'TG-0001')`);
    }

    if (status) {
      values.push(String(status).toUpperCase());

      conditions.push(
        `e.status = $${values.length}`
      );
    }

    if (source) {
      values.push(String(source).toUpperCase());

      conditions.push(
        `e.source = $${values.length}`
      );
    }

    if (property_id) {
      values.push(property_id);

      conditions.push(
        `e.property_id = $${values.length}`
      );
    }

    if (search) {
      values.push(
        `%${String(search).toLowerCase()}%`
      );

      conditions.push(`
        (
          LOWER(g.full_name) LIKE $${values.length}
          OR LOWER(COALESCE(g.email, '')) LIKE $${values.length}
          OR LOWER(COALESCE(g.phone, '')) LIKE $${values.length}
          OR LOWER(COALESCE(g.whatsapp_number, '')) LIKE $${values.length}
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
        e.*,
        CASE
          WHEN e.document_path IS NOT NULL
          THEN '/api/enquiries/' || e.id || '/document'
          ELSE NULL
        END AS document_url,

        g.full_name,
        g.email,
        g.phone,
        g.whatsapp_number,

        p.property_code,
        p.property_name,

        u.full_name AS assigned_to_name

      FROM enquiries e

      JOIN guests g
        ON g.id = e.guest_id

      LEFT JOIN properties p
        ON p.id = e.property_id

      LEFT JOIN users u
        ON u.id = e.assigned_to

      ${whereClause}

      ORDER BY e.created_at DESC
      `,
      values
    );

    return res.json({
      success: true,
      total: result.rows.length,
      enquiries: result.rows
    });

  } catch (error) {
    console.error('Get enquiries error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to load enquiries',
      error: error.message
    });
  }
};


// ======================================================
// GET ONE ENQUIRY
// ======================================================

const getEnquiryById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT
        e.*,
        CASE
          WHEN e.document_path IS NOT NULL
          THEN '/api/enquiries/' || e.id || '/document'
          ELSE NULL
        END AS document_url,

        g.full_name,
        g.email,
        g.phone,
        g.whatsapp_number,
        g.city,

        p.property_code,
        p.property_name,

        u.full_name AS assigned_to_name

      FROM enquiries e

      JOIN guests g
        ON g.id = e.guest_id

      LEFT JOIN properties p
        ON p.id = e.property_id

      LEFT JOIN users u
        ON u.id = e.assigned_to

      WHERE e.id = $1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Enquiry not found'
      });
    }

    return res.json({
      success: true,
      enquiry: result.rows[0]
    });

  } catch (error) {
    console.error('Get enquiry error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to load enquiry',
      error: error.message
    });
  }
};


// ======================================================
// UPDATE ENQUIRY
// ======================================================

const updateEnquiry = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;

    const {
      property_id,
      check_in,
      check_out,
      adults,
      children,
      guest_message,
      quoted_amount,
      status,
      assigned_to
    } = req.body;

    let normalizedStatus = null;
    let statusChanged = false;

    if (status) {
      normalizedStatus = String(status).toUpperCase();

      if (!ALLOWED_STATUSES.includes(normalizedStatus)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid enquiry status'
        });
      }
    }

    await client.query('BEGIN');
    const currentResult = await client.query(
      `SELECT * FROM enquiries WHERE id = $1::bigint FOR UPDATE`,
      [id]
    );
    if (!currentResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Enquiry not found' });
    }
    const current = currentResult.rows[0];

    if (normalizedStatus) {
      let hasActiveBooking = false;
      if (['LOST', 'CANCELLED'].includes(normalizedStatus)) {
        const bookingResult = await client.query(
          `SELECT 1 FROM bookings
            WHERE enquiry_id = $1::bigint
              AND booking_status IN ('HOLD', 'CONFIRMED', 'CHECKED_IN')
            LIMIT 1`,
          [id]
        );
        hasActiveBooking = bookingResult.rows.length > 0;
      }
      const transition = validateGenericTransition({
        currentStatus: current.status,
        requestedStatus: normalizedStatus,
        role: req.user.role,
        hasActiveBooking
      });
      statusChanged = transition.changed;
    }

    const result = await client.query(
      `
      UPDATE enquiries
      SET
        property_id = COALESCE($1, property_id),
        check_in = COALESCE($2, check_in),
        check_out = COALESCE($3, check_out),
        adults = COALESCE($4, adults),
        children = COALESCE($5, children),
        guest_message = COALESCE($6, guest_message),
        quoted_amount = COALESCE($7, quoted_amount),
        status = COALESCE($8, status),
        assigned_to = COALESCE($9, assigned_to),
        updated_at = CURRENT_TIMESTAMP

      WHERE id = $10

      RETURNING *
      `,
      [
        property_id || null,
        check_in || null,
        check_out || null,
        adults ?? null,
        children ?? null,
        guest_message || null,
        quoted_amount ?? null,
        normalizedStatus,
        assigned_to || null,
        id
      ]
    );

    await client.query('COMMIT');

    if (statusChanged && ['LOST', 'CANCELLED'].includes(normalizedStatus)) {
      triggerEnquiryWhatsAppAutomation({
        event: 'BOOKING_REJECTED',
        enquiryId: result.rows[0].id,
        rejectionReason: req.body.rejection_reason || guest_message
      });
    }

    return res.json({
      success: true,
      message: 'Enquiry updated successfully',
      enquiry: result.rows[0]
    });

  } catch (error) {
    await client.query('ROLLBACK');
    if (error instanceof EnquiryTransitionError) {
      return res.status(error.status).json({
        success: false,
        code: error.code,
        message: error.message
      });
    }
    console.error('Update enquiry error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to update enquiry',
      error: error.message
    });
  } finally {
    client.release();
  }
};


const reviewIdentityDocument = async (req, res) => {
  try {
    const status = String(req.body.status || '').toUpperCase();
    if (!['VERIFIED', 'REJECTED'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Document status must be VERIFIED or REJECTED'
      });
    }

    const rejectionReason = status === 'REJECTED'
      ? String(req.body.rejection_reason || '').trim() || null
      : null;
    const currentResult = await pool.query(
      `SELECT id, document_path, document_verification_status
         FROM enquiries WHERE id = $1::bigint`,
      [req.params.id]
    );
    if (!currentResult.rows.length || !currentResult.rows[0].document_path) {
      return res.status(404).json({ success: false, message: 'Application document not found' });
    }
    if (currentResult.rows[0].document_verification_status === status) {
      return res.json({
        success: true,
        message: `Identity document is already ${status.toLowerCase()}`,
        unchanged: true
      });
    }
    const result = await pool.query(
      `UPDATE enquiries
          SET document_verification_status = $1,
              document_reviewed_by = $3::bigint,
              document_reviewed_at = CURRENT_TIMESTAMP,
              document_rejection_reason = $4,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $2 AND document_path IS NOT NULL
          AND document_verification_status IS DISTINCT FROM $1
        RETURNING *`,
      [status, req.params.id, req.user.id, rejectionReason]
    );

    if (!result.rows.length) return res.status(409).json({ success: false, code: 'DOCUMENT_REVIEW_CONFLICT', message: 'Document review state changed; reload and try again' });
    if (status === 'REJECTED') {
      triggerEnquiryWhatsAppAutomation({
        event: 'BOOKING_REJECTED',
        enquiryId: result.rows[0].id,
        rejectionReason
      });
    }
    return res.json({
      success: true,
      message: `Identity document marked ${status.toLowerCase()}`,
      enquiry: result.rows[0]
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Unable to review identity document',
      error: error.message
    });
  }
};

const viewIdentityDocument = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT document_path, document_original_name, document_mime_type
         FROM enquiries
        WHERE id = $1::bigint AND document_path IS NOT NULL`,
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: 'Application document not found' });
    }

    const document = result.rows[0];
    const uploadDirectory = path.resolve(__dirname, '../uploads/identity-documents');
    const documentPath = path.resolve(__dirname, '..', document.document_path);
    const relativePath = path.relative(uploadDirectory, documentPath);

    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return res.status(400).json({ success: false, message: 'Invalid document path' });
    }

    if (!fs.existsSync(documentPath)) {
      return res.status(404).json({ success: false, message: 'Application document file not found' });
    }

    res.set('Cache-Control', 'private, no-store');
    res.type(document.document_mime_type || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${path.basename(document.document_original_name || documentPath).replace(/["\r\n]/g, '')}"`);
    return res.sendFile(documentPath);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Unable to load application document',
      error: error.message
    });
  }
};

const approveApplication = async (req, res) => {
  try {
    const currentResult = await pool.query(
      `SELECT e.*, g.full_name, g.email, g.phone, g.whatsapp_number,
              p.property_name, p.property_code
         FROM enquiries e
         JOIN guests g ON g.id = e.guest_id
         JOIN properties p ON p.id = e.property_id
        WHERE e.id = $1::bigint`,
      [req.params.id]
    );
    if (!currentResult.rows.length) {
      return res.status(404).json({ success: false, message: 'Enquiry not found' });
    }
    const current = currentResult.rows[0];
    const transition = validateApproval({
      currentStatus: current.status,
      documentPath: current.document_path,
      documentVerificationStatus: current.document_verification_status
    });
    if (!transition.changed) {
      return res.json({
        success: true,
        message: 'Application is already approved',
        already_approved: true,
        enquiry: current,
        notifications: { sent: false, reason: 'already_approved' }
      });
    }

    const result = await pool.query(
      `UPDATE enquiries e
          SET status = 'QUALIFIED', updated_at = CURRENT_TIMESTAMP
         FROM guests g, properties p
        WHERE e.id = $1::bigint AND e.guest_id = g.id AND e.property_id = p.id
          AND e.document_path IS NOT NULL AND e.document_verification_status = 'VERIFIED'
          AND e.status = $2
        RETURNING e.*, g.full_name, g.email, g.phone, g.whatsapp_number,
                  p.property_name, p.property_code`,
      [req.params.id, current.status]
    );
    if (!result.rows.length) {
      return res.status(409).json({
        success: false,
        code: 'APPROVAL_CONFLICT',
        message: 'Application changed while approval was being processed; reload and try again'
      });
    }
    const application = result.rows[0];
    const notificationJobs = [
      sendWhatsAppAutomation({
        event: 'BOOKING_APPROVED',
        phone: application.whatsapp_number || application.phone,
        name: application.full_name,
        bookingReference: `APP-${application.id}`,
        propertyId: application.property_code || application.property_id,
        propertyName: application.property_name,
        checkIn: application.check_in,
        checkOut: application.check_out,
        guestsCount: Number(application.adults || 0) + Number(application.children || 0) + Number(application.infants || 0),
        amount: application.quoted_total_amount || application.quoted_amount,
        status: application.status
      })
    ];
    if (application.email) {
      notificationJobs.push(sendEmail({
        to: application.email,
        subject: `Application approved #${application.id}`,
        text: `Hi ${application.full_name}, your application for ${application.property_name} has been approved. Our team will contact you with the next steps.`
      }));
    }
    const notificationResults = await Promise.allSettled(notificationJobs);
    const failed = notificationResults
      .map((item, index) => ({ item, channel: index === 0 ? 'whatsapp' : 'email' }))
      .filter(({ item }) => item.status === 'rejected')
      .map(({ item, channel }) => ({ channel, error: item.reason?.message || 'Notification failed' }));

    return res.json({
      success: true,
      message: 'Application approved',
      enquiry: application,
      notifications: { sent: failed.length === 0, failures: failed }
    });
  } catch (error) {
    if (error instanceof EnquiryTransitionError) {
      return res.status(error.status).json({
        success: false,
        code: error.code,
        message: error.message
      });
    }
    return res.status(500).json({ success: false, message: 'Unable to approve application', error: error.message });
  }
};

module.exports = {
  createPublicEnquiry,
  createEnquiry,
  getEnquiries,
  getEnquiryById,
  updateEnquiry,
  viewIdentityDocument,
  reviewIdentityDocument,
  approveApplication
};
