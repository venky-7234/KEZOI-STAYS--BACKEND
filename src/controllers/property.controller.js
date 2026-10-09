const pool = require('../config/database');

const PROPERTY_STATUSES = ['ACTIVE', 'INACTIVE'];

const parseRequiredText = (value) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const isPositiveInteger = (value) =>
  Number.isInteger(Number(value)) && Number(value) > 0;

const isNonNegativePrice = (value) =>
  value !== '' && value != null && Number.isFinite(Number(value)) && Number(value) >= 0;

// ======================================================
// CREATE PROPERTY
// ======================================================

const createProperty = async (req, res) => {
  try {
    const {
      property_code,
      property_name,
      property_type,
      address,
      area,
      city = 'Hyderabad',
      bedrooms,
      bathrooms,
      max_guests,
      base_price,
      included_guests = 6,
      extra_guest_price = 0,
      airbnb_url,
      status = 'ACTIVE'
    } = req.body;

    const propertyCode = parseRequiredText(property_code);
    const propertyName = parseRequiredText(property_name);
    const normalizedStatus = String(status).toUpperCase();

    if (!propertyCode || !propertyName || base_price == null || base_price === '' || max_guests == null || max_guests === '') {
      return res.status(400).json({
        success: false,
        message: 'property_code, property_name, max_guests and base_price are required'
      });
    }

    const includedGuestsNumber = Number(included_guests);
    const extraGuestPriceNumber = Number(extra_guest_price);
    const maxGuestsNumber = max_guests == null ? null : Number(max_guests);
    const basePriceNumber = base_price == null ? null : Number(base_price);

    if (!Number.isInteger(includedGuestsNumber) || includedGuestsNumber < 1 ||
        !Number.isFinite(extraGuestPriceNumber) || extraGuestPriceNumber < 0 ||
        !Number.isInteger(maxGuestsNumber) || maxGuestsNumber < includedGuestsNumber ||
        !Number.isFinite(basePriceNumber) || basePriceNumber < 0 ||
        !PROPERTY_STATUSES.includes(normalizedStatus)) {
      return res.status(400).json({
        success: false,
        message: 'Guest limits must be positive whole numbers, included_guests cannot exceed max_guests, prices cannot be negative, and status must be ACTIVE or INACTIVE'
      });
    }

    const existing = await pool.query(
      `
      SELECT id
      FROM properties
      WHERE LOWER(property_code) = LOWER($1)
      LIMIT 1
      `,
      [propertyCode]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Property code already exists'
      });
    }

    const result = await pool.query(
      `
      INSERT INTO properties (
        property_code,
        property_name,
        property_type,
        address,
        area,
        city,
        bedrooms,
        bathrooms,
        max_guests,
        base_price,
        included_guests,
        extra_guest_price,
        airbnb_url,
        status
      )
      VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12, $13,
        $14
      )
      RETURNING *
      `,
      [
        propertyCode,
        propertyName,
        property_type || null,
        address || null,
        area || null,
        city || 'Hyderabad',
        bedrooms ?? null,
        bathrooms ?? null,
        maxGuestsNumber,
        basePriceNumber,
        includedGuestsNumber,
        extraGuestPriceNumber,
        airbnb_url || null,
        normalizedStatus
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Property created successfully',
      property: result.rows[0]
    });

  } catch (error) {
    console.error('Create property error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to create property',
      error: error.message
    });
  }
};


// ======================================================
// LIST PROPERTIES
// ======================================================

const getProperties = async (req, res) => {
  try {
    const {
      status,
      city,
      search
    } = req.query;

    const values = [];
    const conditions = [];

    if (status) {
      values.push(String(status).toUpperCase());

      conditions.push(
        `status = $${values.length}`
      );
    }

    if (city) {
      values.push(city);

      conditions.push(
        `LOWER(city) = LOWER($${values.length})`
      );
    }

    if (search) {
      values.push(`%${String(search).toLowerCase()}%`);

      conditions.push(`
        (
          LOWER(property_name) LIKE $${values.length}
          OR LOWER(property_code) LIKE $${values.length}
          OR LOWER(COALESCE(area, '')) LIKE $${values.length}
          OR LOWER(COALESCE(city, '')) LIKE $${values.length}
        )
      `);
    }

    const whereClause =
      conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : '';

    const result = await pool.query(
      `
      SELECT *
      FROM properties
      ${whereClause}
      ORDER BY created_at DESC
      `,
      values
    );

    return res.json({
      success: true,
      total: result.rows.length,
      properties: result.rows
    });

  } catch (error) {
    console.error('Get properties error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to load properties',
      error: error.message
    });
  }
};


// ======================================================
// GET PROPERTY BY ID
// ======================================================

const getPropertyById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT *
      FROM properties
      WHERE id = $1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    return res.json({
      success: true,
      property: result.rows[0]
    });

  } catch (error) {
    console.error('Get property error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to load property',
      error: error.message
    });
  }
};


// ======================================================
// UPDATE PROPERTY
// ======================================================

const updateProperty = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      property_code,
      property_name,
      property_type,
      address,
      area,
      city,
      bedrooms,
      bathrooms,
      max_guests,
      base_price,
      included_guests,
      extra_guest_price,
      airbnb_url,
      status
    } = req.body;

    const existingResult = await pool.query(
      `SELECT * FROM properties WHERE id = $1`,
      [id]
    );

    if (existingResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    const existingProperty = existingResult.rows[0];
    const effectiveMaxGuests = max_guests ?? existingProperty.max_guests;
    const effectiveIncludedGuests = included_guests ?? existingProperty.included_guests;
    const effectiveBasePrice = base_price ?? existingProperty.base_price;
    const effectiveExtraGuestPrice = extra_guest_price ?? existingProperty.extra_guest_price;

    const normalizedStatus = status == null ? existingProperty.status : String(status).toUpperCase();

    if (
      !isPositiveInteger(effectiveMaxGuests) ||
      !isPositiveInteger(effectiveIncludedGuests) ||
      !isNonNegativePrice(effectiveBasePrice) ||
      !isNonNegativePrice(effectiveExtraGuestPrice) ||
      (effectiveMaxGuests != null &&
        Number(effectiveIncludedGuests) > Number(effectiveMaxGuests)) ||
      !PROPERTY_STATUSES.includes(normalizedStatus)
    ) {
      return res.status(400).json({
        success: false,
        message: 'max_guests and included_guests must be positive whole numbers, included_guests cannot exceed max_guests, prices cannot be negative, and status must be ACTIVE or INACTIVE'
      });
    }

    if (property_code) {
      const duplicateCode = await pool.query(
        `SELECT id FROM properties
          WHERE LOWER(property_code) = LOWER($1) AND id <> $2
          LIMIT 1`,
        [property_code.trim(), id]
      );

      if (duplicateCode.rows.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'Property code already exists'
        });
      }
    }

    const result = await pool.query(
      `
      UPDATE properties
      SET
        property_code = COALESCE($1, property_code),
        property_name = COALESCE($2, property_name),
        property_type = COALESCE($3, property_type),
        address = COALESCE($4, address),
        area = COALESCE($5, area),
        city = COALESCE($6, city),
        bedrooms = COALESCE($7, bedrooms),
        bathrooms = COALESCE($8, bathrooms),
        max_guests = COALESCE($9, max_guests),
        base_price = COALESCE($10, base_price),
        included_guests = COALESCE($11, included_guests),
        extra_guest_price = COALESCE($12, extra_guest_price),
        airbnb_url = COALESCE($13, airbnb_url),
        status = COALESCE($14, status),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $15
      RETURNING *
      `,
      [
        property_code ? property_code.trim() : null,
        property_name ? property_name.trim() : null,
        property_type || null,
        address || null,
        area || null,
        city || null,
        bedrooms ?? null,
        bathrooms ?? null,
        max_guests ?? null,
        base_price ?? null,
        included_guests ?? null,
        extra_guest_price ?? null,
        airbnb_url || null,
        status == null ? null : normalizedStatus,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    return res.json({
      success: true,
      message: 'Property updated successfully',
      property: result.rows[0]
    });

  } catch (error) {
    console.error('Update property error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to update property',
      error: error.message
    });
  }
};


// ======================================================
// CREATE PROPERTY BLOCK
// Airbnb / Maintenance / Owner Stay / Cleaning / Manual
// ======================================================

const createPropertyBlock = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      start_date,
      end_date,
      block_type = 'MANUAL',
      reason
    } = req.body;

    if (!start_date || !end_date) {
      return res.status(400).json({
        success: false,
        message: 'Start date and end date are required'
      });
    }

    if (new Date(end_date) <= new Date(start_date)) {
      return res.status(400).json({
        success: false,
        message: 'End date must be after start date'
      });
    }

    const propertyResult = await pool.query(
      `
      SELECT id
      FROM properties
      WHERE id = $1
      `,
      [id]
    );

    if (propertyResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    const overlap = await pool.query(
      `
      SELECT id
      FROM property_blocks
      WHERE property_id = $1
        AND start_date < $3
        AND end_date > $2
      LIMIT 1
      `,
      [
        id,
        start_date,
        end_date
      ]
    );

    if (overlap.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Property already has a block overlapping these dates'
      });
    }

    const bookingOverlap = await pool.query(
      `SELECT id FROM bookings
       WHERE property_id = $1
         AND booking_status IN ('HOLD', 'CONFIRMED', 'CHECKED_IN')
         AND check_in < $3 AND check_out > $2
       LIMIT 1`,
      [id, start_date, end_date]
    );

    if (bookingOverlap.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'These dates already contain a booking and are already unavailable'
      });
    }

    const result = await pool.query(
      `
      INSERT INTO property_blocks (
        property_id,
        start_date,
        end_date,
        block_type,
        reason,
        created_by
      )
      VALUES (
        $1, $2, $3, $4, $5, $6
      )
      RETURNING *
      `,
      [
        id,
        start_date,
        end_date,
        String(block_type).toUpperCase(),
        reason || null,
        req.user.id
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Property block created successfully',
      block: result.rows[0]
    });

  } catch (error) {
    console.error('Create property block error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to block property',
      error: error.message
    });
  }
};


// ======================================================
// GET PROPERTY BLOCKS
// ======================================================

const getPropertyBlocks = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT
        pb.*,
        u.full_name AS created_by_name
      FROM property_blocks pb
      LEFT JOIN users u
        ON u.id = pb.created_by
      WHERE pb.property_id = $1
      ORDER BY pb.start_date ASC
      `,
      [id]
    );

    return res.json({
      success: true,
      total: result.rows.length,
      blocks: result.rows
    });

  } catch (error) {
    console.error('Get property blocks error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to load property blocks',
      error: error.message
    });
  }
};


// ======================================================
// DELETE PROPERTY BLOCK
// ======================================================

const deletePropertyBlock = async (req, res) => {
  try {
    const { blockId } = req.params;

    const result = await pool.query(
      `
      DELETE FROM property_blocks
      WHERE id = $1
      RETURNING *
      `,
      [blockId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Property block not found'
      });
    }

    return res.json({
      success: true,
      message: 'Property block removed successfully'
    });

  } catch (error) {
    console.error('Delete property block error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to remove property block',
      error: error.message
    });
  }
};


// ======================================================
// CHECK AVAILABILITY
// ======================================================

const checkAvailability = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      check_in,
      check_out
    } = req.query;

    if (!check_in || !check_out) {
      return res.status(400).json({
        success: false,
        message: 'check_in and check_out are required'
      });
    }

    if (new Date(check_out) <= new Date(check_in)) {
      return res.status(400).json({
        success: false,
        message: 'Check-out date must be after check-in date'
      });
    }

    const propertyResult = await pool.query(
      `
      SELECT *
      FROM properties
      WHERE id = $1
      `,
      [id]
    );

    if (propertyResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    const bookingsResult = await pool.query(
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
      `,
      [
        id,
        check_in,
        check_out
      ]
    );

    const blocksResult = await pool.query(
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
      `,
      [
        id,
        check_in,
        check_out
      ]
    );

    const available =
      bookingsResult.rows.length === 0 &&
      blocksResult.rows.length === 0;

    return res.json({
      success: true,
      available,
      property: propertyResult.rows[0],
      conflictingBookings: bookingsResult.rows,
      conflictingBlocks: blocksResult.rows
    });

  } catch (error) {
    console.error('Check availability error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to check availability',
      error: error.message
    });
  }
};


module.exports = {
  createProperty,
  getProperties,
  getPropertyById,
  updateProperty,
  createPropertyBlock,
  getPropertyBlocks,
  deletePropertyBlock,
  checkAvailability
};
