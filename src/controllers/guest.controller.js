const pool = require('../config/database');
const { validatePhoneNumber, INVALID_MOBILE_MESSAGE } = require('../utils/phoneValidator');

const parseReferral = (name, mobile) => {
  const referralName = String(name || '').trim() || null;
  const referralMobileInput = String(mobile || '').trim();
  if (!referralName && !referralMobileInput) return { referralName: null, referralMobile: null };
  if (!referralName || !referralMobileInput) return { error: 'Referral name and mobile number must be provided together' };
  const validation = validatePhoneNumber(referralMobileInput);
  if (!validation.valid) return { error: `Referral ${INVALID_MOBILE_MESSAGE.toLowerCase()}` };
  return { referralName, referralMobile: validation.normalizedNumber };
};

const createGuest = async (req, res) => {
  try {
    const {
      full_name,
      email,
      phone,
      whatsapp_number,
      city,
      country = 'India',
      source = 'OTHER',
      notes,
      referral_name,
      referral_mobile
    } = req.body;

    if (!full_name) {
      return res.status(400).json({
        success: false,
        message: 'Full name is required'
      });
    }
    const referral = parseReferral(referral_name, referral_mobile);
    if (referral.error) return res.status(400).json({ success: false, message: referral.error });

    const normalizedEmail = email ? email.trim().toLowerCase() : null;

    // Prevent duplicate guest by email or phone
    const existing = await pool.query(
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
      [normalizedEmail, phone || null, whatsapp_number || null]
    );

    if (existing.rows.length > 0) {
      return res.status(200).json({
        success: true,
        message: 'Existing guest found',
        guest: existing.rows[0],
        existing: true
      });
    }

    const result = await pool.query(
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
        notes,
        guest_status,
        referral_name,
        referral_mobile
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP,
        $8, 'ACTIVE', $9, $10
      )
      RETURNING *
      `,
      [
        full_name.trim(),
        normalizedEmail,
        phone || null,
        whatsapp_number || null,
        city || null,
        country,
        String(source).toUpperCase(),
        notes || null,
        referral.referralName,
        referral.referralMobile
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Guest created successfully',
      guest: result.rows[0],
      existing: false
    });

  } catch (error) {
    console.error('Create guest error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to create guest',
      error: error.message
    });
  }
};

const getGuests = async (req, res) => {
  try {
    const {
      search,
      source,
      status
    } = req.query;

    const values = [];
    const conditions = [];

    if (search) {
      values.push(`%${search.toLowerCase()}%`);

      conditions.push(`
        (
          LOWER(full_name) LIKE $${values.length}
          OR LOWER(COALESCE(email, '')) LIKE $${values.length}
          OR LOWER(COALESCE(phone, '')) LIKE $${values.length}
          OR LOWER(COALESCE(whatsapp_number, '')) LIKE $${values.length}
          OR LOWER(COALESCE(referral_name, '')) LIKE $${values.length}
          OR LOWER(COALESCE(referral_mobile, '')) LIKE $${values.length}
        )
      `);
    }

    if (source) {
      values.push(String(source).toUpperCase());
      conditions.push(`source = $${values.length}`);
    }

    if (status) {
      values.push(String(status).toUpperCase());
      conditions.push(`guest_status = $${values.length}`);
    }

    const whereClause =
      conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : '';

    const result = await pool.query(
      `
      SELECT *
      FROM guests
      ${whereClause}
      ORDER BY created_at DESC
      `,
      values
    );

    return res.json({
      success: true,
      total: result.rows.length,
      guests: result.rows
    });

  } catch (error) {
    console.error('Get guests error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to load guests',
      error: error.message
    });
  }
};

const getGuestById = async (req, res) => {
  try {
    const { id } = req.params;

    const guestResult = await pool.query(
      `
      SELECT *
      FROM guests
      WHERE id = $1
      `,
      [id]
    );

    if (guestResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Guest not found'
      });
    }

    const enquiries = await pool.query(
      `
      SELECT *
      FROM enquiries
      WHERE guest_id = $1
      ORDER BY created_at DESC
      `,
      [id]
    );

    const bookings = await pool.query(
      `
      SELECT
        b.*,
        p.property_name,
        p.property_code
      FROM bookings b
      LEFT JOIN properties p
        ON p.id = b.property_id
      WHERE b.guest_id = $1
      ORDER BY b.created_at DESC
      `,
      [id]
    );

    return res.json({
      success: true,
      guest: guestResult.rows[0],
      enquiries: enquiries.rows,
      bookings: bookings.rows
    });

  } catch (error) {
    console.error('Get guest error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to load guest',
      error: error.message
    });
  }
};

const updateGuest = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      full_name,
      email,
      phone,
      whatsapp_number,
      city,
      country,
      source,
      guest_status,
      notes,
      referral_name,
      referral_mobile
    } = req.body;

    let referral = null;
    if (referral_name !== undefined || referral_mobile !== undefined) {
      referral = parseReferral(referral_name, referral_mobile);
      if (referral.error) return res.status(400).json({ success: false, message: referral.error });
    }

    const result = await pool.query(
      `
      UPDATE guests
      SET
        full_name = COALESCE($1, full_name),
        email = COALESCE($2, email),
        phone = COALESCE($3, phone),
        whatsapp_number = COALESCE($4, whatsapp_number),
        city = COALESCE($5, city),
        country = COALESCE($6, country),
        source = COALESCE($7, source),
        guest_status = COALESCE($8, guest_status),
        notes = COALESCE($9, notes),
        referral_name = CASE WHEN $10::boolean THEN $11::varchar ELSE referral_name END,
        referral_mobile = CASE WHEN $10::boolean THEN $12::varchar ELSE referral_mobile END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $13
      RETURNING *
      `,
      [
        full_name || null,
        email ? email.trim().toLowerCase() : null,
        phone || null,
        whatsapp_number || null,
        city || null,
        country || null,
        source ? String(source).toUpperCase() : null,
        guest_status ? String(guest_status).toUpperCase() : null,
        notes || null,
        referral !== null,
        referral?.referralName || null,
        referral?.referralMobile || null,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Guest not found'
      });
    }

    return res.json({
      success: true,
      message: 'Guest updated successfully',
      guest: result.rows[0]
    });

  } catch (error) {
    console.error('Update guest error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to update guest',
      error: error.message
    });
  }
};

module.exports = {
  createGuest,
  getGuests,
  getGuestById,
  updateGuest
};
