const pool = require('../config/database');
const { imageUrlToMetaBase64 } = require('../services/metaImage.service');

const validateMetaImage = value => {
  const base64 = String(value || '').replace(/^data:image\/(?:png|jpeg);base64,/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return { error: 'meta_image_base64 must be raw JPEG or PNG base64' };
  const bytes = Buffer.from(base64, 'base64');
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!jpeg && !png) return { error: 'Only JPEG and PNG carousel images are supported' };
  if (bytes.length > 240 * 1024) return { error: 'Carousel images must not exceed the safe 240 KB per-image budget' };
  return { base64 };
};

const listMarketingPhotos = async (req, res) => {
  try {
    const result = await pool.query(`SELECT id, property_id, image_url, alt_text, caption, display_order,
      is_cover, is_active, created_at, updated_at FROM property_marketing_photos
      WHERE property_id=$1 ORDER BY is_cover DESC, display_order, id`, [req.params.propertyId]);
    return res.json({ success: true, total: result.rows.length, photos: result.rows });
  } catch (error) { return res.status(500).json({ success: false, message: 'Unable to load marketing gallery' }); }
};

const addMarketingPhoto = async (req, res) => {
  if (!String(req.body.alt_text || '').trim() || (!req.body.meta_image_base64 && !req.body.image_url)) return res.status(400).json({ success: false, message: 'alt_text and image_url or meta_image_base64 are required' });
  let image;
  try { image = req.body.meta_image_base64 ? validateMetaImage(req.body.meta_image_base64) : { base64: await imageUrlToMetaBase64(req.body.image_url) }; }
  catch (error) { return res.status(400).json({ success: false, message: error.message }); }
  if (image.error) return res.status(400).json({ success: false, message: image.error });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (req.body.is_cover === true) await client.query('UPDATE property_marketing_photos SET is_cover=FALSE,updated_at=NOW() WHERE property_id=$1', [req.body.property_id]);
    const result = await client.query(`INSERT INTO property_marketing_photos(property_id,image_url,meta_image_base64,alt_text,caption,display_order,is_cover,is_active)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,property_id,image_url,alt_text,caption,display_order,is_cover,is_active,created_at,updated_at`,
      [req.body.property_id, req.body.image_url || null, image.base64, String(req.body.alt_text).trim(), req.body.caption || null, Number(req.body.display_order || 0), req.body.is_cover === true, req.body.is_active !== false]);
    await client.query('COMMIT');
    return res.status(201).json({ success: true, photo: result.rows[0] });
  } catch (error) { await client.query('ROLLBACK'); return res.status(500).json({ success: false, message: 'Unable to add marketing photo' }); }
  finally { client.release(); }
};

const updateMarketingPhoto = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM property_marketing_photos WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!current.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'Marketing photo not found' }); }
    let base64 = current.rows[0].meta_image_base64;
    if (req.body.meta_image_base64 != null) { const image = validateMetaImage(req.body.meta_image_base64); if (image.error) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: image.error }); } base64 = image.base64; }
    else if (req.body.image_url != null && req.body.image_url !== current.rows[0].image_url) {
      try { base64 = await imageUrlToMetaBase64(req.body.image_url); }
      catch (error) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: error.message }); }
    }
    if (req.body.is_cover === true) await client.query('UPDATE property_marketing_photos SET is_cover=FALSE,updated_at=NOW() WHERE property_id=$1 AND id<>$2', [current.rows[0].property_id, req.params.id]);
    const result = await client.query(`UPDATE property_marketing_photos SET image_url=$1,meta_image_base64=$2,alt_text=$3,caption=$4,display_order=$5,is_cover=$6,is_active=$7,updated_at=NOW()
      WHERE id=$8 RETURNING id,property_id,image_url,alt_text,caption,display_order,is_cover,is_active,created_at,updated_at`,
      [req.body.image_url ?? current.rows[0].image_url, base64, req.body.alt_text ?? current.rows[0].alt_text, req.body.caption ?? current.rows[0].caption, req.body.display_order ?? current.rows[0].display_order, req.body.is_cover ?? current.rows[0].is_cover, req.body.is_active ?? current.rows[0].is_active, req.params.id]);
    await client.query('COMMIT'); return res.json({ success: true, photo: result.rows[0] });
  } catch (error) { await client.query('ROLLBACK'); return res.status(500).json({ success: false, message: 'Unable to update marketing photo' }); }
  finally { client.release(); }
};

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
  deleteAssetPhoto,
  listMarketingPhotos,
  addMarketingPhoto,
  updateMarketingPhoto
};
