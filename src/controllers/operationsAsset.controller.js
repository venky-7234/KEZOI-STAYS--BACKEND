const pool = require('../config/database');


// ======================================================
// CREATE ASSET
// ======================================================

const createAsset = async (req, res) => {
  try {
    const {
      property_id,
      asset_name,
      category,
      room_location,
      quantity = 1,
      purchase_price = 0,
      purchase_date,
      vendor_name,
      vendor_phone,
      brand,
      model,
      serial_number,
      warranty_expiry,
      condition = 'NEW',
      asset_status = 'ACTIVE',
      notes
    } = req.body;

    if (!property_id || !asset_name) {
      return res.status(400).json({
        success: false,
        message: 'property_id and asset_name are required'
      });
    }

    const propertyResult = await pool.query(
      `
      SELECT id
      FROM properties
      WHERE id = $1
      `,
      [property_id]
    );

    if (propertyResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    const result = await pool.query(
      `
      INSERT INTO property_assets (
        property_id,
        asset_name,
        category,
        room_location,
        quantity,
        purchase_price,
        purchase_date,
        vendor_name,
        vendor_phone,
        brand,
        model,
        serial_number,
        warranty_expiry,
        condition,
        asset_status,
        notes,
        created_by
      )
      VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11, $12,
        $13, $14, $15, $16,
        $17
      )
      RETURNING *
      `,
      [
        property_id,
        asset_name.trim(),
        category || null,
        room_location || null,
        Number(quantity) || 1,
        Number(purchase_price) || 0,
        purchase_date || null,
        vendor_name || null,
        vendor_phone || null,
        brand || null,
        model || null,
        serial_number || null,
        warranty_expiry || null,
        String(condition).toUpperCase(),
        String(asset_status).toUpperCase(),
        notes || null,
        req.user.id
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Asset created successfully',
      asset: result.rows[0]
    });

  } catch (error) {
    console.error('Create asset error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to create asset',
      error: error.message
    });
  }
};


// ======================================================
// GET ALL ASSETS
// ======================================================

const getAssets = async (req, res) => {
  try {
    const {
      property_id,
      category,
      status,
      search
    } = req.query;

    const values = [];
    const conditions = [];

    if (property_id) {
      values.push(property_id);

      conditions.push(
        `a.property_id = $${values.length}`
      );
    }

    if (category) {
      values.push(
        String(category).toLowerCase()
      );

      conditions.push(
        `LOWER(a.category) = $${values.length}`
      );
    }

    if (status) {
      values.push(
        String(status).toUpperCase()
      );

      conditions.push(
        `a.asset_status = $${values.length}`
      );
    }

    if (search) {
      values.push(
        `%${String(search).toLowerCase()}%`
      );

      conditions.push(`
        (
          LOWER(a.asset_name)
            LIKE $${values.length}

          OR LOWER(
            COALESCE(a.brand, '')
          ) LIKE $${values.length}

          OR LOWER(
            COALESCE(a.model, '')
          ) LIKE $${values.length}

          OR LOWER(
            COALESCE(a.serial_number, '')
          ) LIKE $${values.length}

          OR LOWER(
            COALESCE(a.room_location, '')
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
        a.*,

        p.property_code,
        p.property_name,

        u.full_name AS created_by_name,

        (
          SELECT COUNT(*)
          FROM asset_photos ap
          WHERE ap.asset_id = a.id
        )::int AS photo_count

      FROM property_assets a

      JOIN properties p
        ON p.id = a.property_id

      LEFT JOIN users u
        ON u.id = a.created_by

      ${whereClause}

      ORDER BY
        a.created_at DESC
      `,
      values
    );

    return res.json({
      success: true,
      total: result.rows.length,
      assets: result.rows
    });

  } catch (error) {
    console.error('Get assets error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to load assets',
      error: error.message
    });
  }
};


// ======================================================
// GET ASSET BY ID
// ======================================================

const getAssetById = async (req, res) => {
  try {
    const { id } = req.params;

    const assetResult = await pool.query(
      `
      SELECT
        a.*,

        p.property_code,
        p.property_name,

        u.full_name AS created_by_name

      FROM property_assets a

      JOIN properties p
        ON p.id = a.property_id

      LEFT JOIN users u
        ON u.id = a.created_by

      WHERE a.id = $1
      `,
      [id]
    );

    if (assetResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Asset not found'
      });
    }

    const photosResult = await pool.query(
      `
      SELECT
        ap.*,
        u.full_name AS uploaded_by_name

      FROM asset_photos ap

      LEFT JOIN users u
        ON u.id = ap.uploaded_by

      WHERE ap.asset_id = $1

      ORDER BY
        ap.created_at DESC
      `,
      [id]
    );

    const maintenanceResult = await pool.query(
      `
      SELECT *
      FROM maintenance_requests
      WHERE asset_id = $1
      ORDER BY created_at DESC
      `,
      [id]
    );

    return res.json({
      success: true,
      asset: assetResult.rows[0],
      photos: photosResult.rows,
      maintenance: maintenanceResult.rows
    });

  } catch (error) {
    console.error('Get asset error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to load asset',
      error: error.message
    });
  }
};


// ======================================================
// UPDATE ASSET
// ======================================================

const updateAsset = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      asset_name,
      category,
      room_location,
      quantity,
      purchase_price,
      purchase_date,
      vendor_name,
      vendor_phone,
      brand,
      model,
      serial_number,
      warranty_expiry,
      condition,
      asset_status,
      notes
    } = req.body;

    const result = await pool.query(
      `
      UPDATE property_assets
      SET
        asset_name =
          COALESCE($1, asset_name),

        category =
          COALESCE($2, category),

        room_location =
          COALESCE($3, room_location),

        quantity =
          COALESCE($4, quantity),

        purchase_price =
          COALESCE($5, purchase_price),

        purchase_date =
          COALESCE($6, purchase_date),

        vendor_name =
          COALESCE($7, vendor_name),

        vendor_phone =
          COALESCE($8, vendor_phone),

        brand =
          COALESCE($9, brand),

        model =
          COALESCE($10, model),

        serial_number =
          COALESCE($11, serial_number),

        warranty_expiry =
          COALESCE($12, warranty_expiry),

        condition =
          COALESCE($13, condition),

        asset_status =
          COALESCE($14, asset_status),

        notes =
          COALESCE($15, notes),

        updated_at =
          CURRENT_TIMESTAMP

      WHERE id = $16

      RETURNING *
      `,
      [
        asset_name || null,
        category || null,
        room_location || null,
        quantity ?? null,
        purchase_price ?? null,
        purchase_date || null,
        vendor_name || null,
        vendor_phone || null,
        brand || null,
        model || null,
        serial_number || null,
        warranty_expiry || null,
        condition
          ? String(condition).toUpperCase()
          : null,
        asset_status
          ? String(asset_status).toUpperCase()
          : null,
        notes || null,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Asset not found'
      });
    }

    return res.json({
      success: true,
      message: 'Asset updated successfully',
      asset: result.rows[0]
    });

  } catch (error) {
    console.error('Update asset error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to update asset',
      error: error.message
    });
  }
};


// ======================================================
// GET PROPERTY ASSET SUMMARY
// ======================================================

const getPropertyAssetSummary = async (
  req,
  res
) => {
  try {
    const { propertyId } = req.params;

    const propertyResult = await pool.query(
      `
      SELECT
        id,
        property_code,
        property_name
      FROM properties
      WHERE id = $1
      `,
      [propertyId]
    );

    if (propertyResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    const summaryResult = await pool.query(
      `
      SELECT
        COUNT(*)::int AS total_asset_records,

        COALESCE(
          SUM(quantity),
          0
        )::int AS total_asset_quantity,

        COALESCE(
          SUM(
            purchase_price * quantity
          ),
          0
        ) AS total_asset_spend,

        COUNT(*) FILTER (
          WHERE asset_status = 'ACTIVE'
        )::int AS active_assets,

        COUNT(*) FILTER (
          WHERE condition = 'DAMAGED'
        )::int AS damaged_assets

      FROM property_assets

      WHERE property_id = $1
      `,
      [propertyId]
    );

    const categoryResult = await pool.query(
      `
      SELECT
        COALESCE(
          category,
          'UNCATEGORIZED'
        ) AS category,

        COUNT(*)::int
          AS asset_records,

        COALESCE(
          SUM(quantity),
          0
        )::int
          AS total_quantity,

        COALESCE(
          SUM(
            purchase_price * quantity
          ),
          0
        )
          AS total_spend

      FROM property_assets

      WHERE property_id = $1

      GROUP BY
        COALESCE(
          category,
          'UNCATEGORIZED'
        )

      ORDER BY
        total_spend DESC
      `,
      [propertyId]
    );

    return res.json({
      success: true,
      property:
        propertyResult.rows[0],

      summary: {
        ...summaryResult.rows[0],

        total_asset_spend:
          Number(
            summaryResult.rows[0]
              .total_asset_spend || 0
          )
      },

      categories:
        categoryResult.rows.map(
          (row) => ({
            ...row,
            total_spend:
              Number(
                row.total_spend || 0
              )
          })
        )
    });

  } catch (error) {
    console.error(
      'Property asset summary error:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Unable to load asset summary',
      error: error.message
    });
  }
};


// ======================================================
// DELETE ASSET
// ======================================================

const deleteAsset = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      DELETE FROM property_assets
      WHERE id = $1
      RETURNING *
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Asset not found'
      });
    }

    return res.json({
      success: true,
      message: 'Asset deleted successfully'
    });

  } catch (error) {
    console.error('Delete asset error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to delete asset',
      error: error.message
    });
  }
};


module.exports = {
  createAsset,
  getAssets,
  getAssetById,
  updateAsset,
  getPropertyAssetSummary,
  deleteAsset
};