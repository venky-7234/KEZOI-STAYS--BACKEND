const pool = require('../config/database');

// ======================================================
// ADD ASSET PHOTO
// ======================================================

const addAssetPhoto = async (req, res) => {
  try {
    const {
      asset_id,
      property_id,
      image_url,
      latitude,
      longitude,
      captured_at,
      notes
    } = req.body;

    if (!asset_id || !property_id || !image_url) {
      return res.status(400).json({
        success: false,
        message:
          'asset_id, property_id and image_url are required'
      });
    }

    const assetResult = await pool.query(
      `
      SELECT id, property_id
      FROM property_assets
      WHERE id = $1
      `,
      [asset_id]
    );

    if (assetResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Asset not found'
      });
    }

    if (
      Number(assetResult.rows[0].property_id) !==
      Number(property_id)
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Asset does not belong to this property'
      });
    }

    const result = await pool.query(
      `
      INSERT INTO asset_photos (
        asset_id,
        property_id,
        image_url,
        latitude,
        longitude,
        captured_at,
        notes,
        uploaded_by
      )
      VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8
      )
      RETURNING *
      `,
      [
        asset_id,
        property_id,
        image_url,
        latitude ?? null,
        longitude ?? null,
        captured_at || new Date(),
        notes || null,
        req.user.id
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Asset photo added successfully',
      photo: result.rows[0]
    });

  } catch (error) {
    console.error('Add asset photo error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to add asset photo',
      error: error.message
    });
  }
};


// ======================================================
// GET PHOTOS FOR ASSET
// ======================================================

const getAssetPhotos = async (req, res) => {
  try {
    const { assetId } = req.params;

    const result = await pool.query(
      `
      SELECT
        ap.*,
        u.full_name AS uploaded_by_name

      FROM asset_photos ap

      LEFT JOIN users u
        ON u.id = ap.uploaded_by

      WHERE ap.asset_id = $1

      ORDER BY ap.created_at DESC
      `,
      [assetId]
    );

    return res.json({
      success: true,
      total: result.rows.length,
      photos: result.rows
    });

  } catch (error) {
    console.error('Get asset photos error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to load asset photos',
      error: error.message
    });
  }
};


// ======================================================
// GET PHOTOS FOR PROPERTY
// ======================================================

const getPropertyPhotos = async (req, res) => {
  try {
    const { propertyId } = req.params;

    const result = await pool.query(
      `
      SELECT
        ap.*,
        a.asset_name,
        a.category,
        a.room_location,
        u.full_name AS uploaded_by_name

      FROM asset_photos ap

      JOIN property_assets a
        ON a.id = ap.asset_id

      LEFT JOIN users u
        ON u.id = ap.uploaded_by

      WHERE ap.property_id = $1

      ORDER BY ap.created_at DESC
      `,
      [propertyId]
    );

    return res.json({
      success: true,
      total: result.rows.length,
      photos: result.rows
    });

  } catch (error) {
    console.error('Get property photos error:', error);

    return res.status(500).json({
      success: false,
      message:
        'Unable to load property photos',
      error: error.message
    });
  }
};


// ======================================================
// UPDATE PHOTO NOTES
// ======================================================

const updateAssetPhoto = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      notes,
      latitude,
      longitude,
      captured_at
    } = req.body;

    const result = await pool.query(
      `
      UPDATE asset_photos
      SET
        notes =
          COALESCE($1, notes),

        latitude =
          COALESCE($2, latitude),

        longitude =
          COALESCE($3, longitude),

        captured_at =
          COALESCE($4, captured_at)

      WHERE id = $5

      RETURNING *
      `,
      [
        notes ?? null,
        latitude ?? null,
        longitude ?? null,
        captured_at || null,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Asset photo not found'
      });
    }

    return res.json({
      success: true,
      message: 'Asset photo updated successfully',
      photo: result.rows[0]
    });

  } catch (error) {
    console.error('Update asset photo error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to update asset photo',
      error: error.message
    });
  }
};


// ======================================================
// DELETE PHOTO
// ======================================================

const deleteAssetPhoto = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      DELETE FROM asset_photos
      WHERE id = $1
      RETURNING *
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Asset photo not found'
      });
    }

    return res.json({
      success: true,
      message: 'Asset photo deleted successfully'
    });

  } catch (error) {
    console.error('Delete asset photo error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to delete asset photo',
      error: error.message
    });
  }
};


module.exports = {
  addAssetPhoto,
  getAssetPhotos,
  getPropertyPhotos,
  updateAssetPhoto,
  deleteAssetPhoto
};