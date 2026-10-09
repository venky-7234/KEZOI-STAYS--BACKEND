const pool = require('../config/database');

const createPropertyNote = async (req, res) => {
  try {
    const { property_id, note } = req.body;

    if (!property_id || !note) {
      return res.status(400).json({
        success: false,
        message: 'property_id and note are required'
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
      INSERT INTO property_notes (
        property_id,
        note,
        created_by
      )
      VALUES ($1, $2, $3)
      RETURNING *
      `,
      [
        property_id,
        note.trim(),
        req.user.id
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Property note added successfully',
      note: result.rows[0]
    });

  } catch (error) {
    console.error('Create property note error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to add property note',
      error: error.message
    });
  }
};


const getPropertyNotes = async (req, res) => {
  try {
    const { propertyId } = req.params;

    const result = await pool.query(
      `
      SELECT
        pn.*,
        u.full_name AS created_by_name
      FROM property_notes pn
      LEFT JOIN users u
        ON u.id = pn.created_by
      WHERE pn.property_id = $1
      ORDER BY pn.created_at DESC
      `,
      [propertyId]
    );

    return res.json({
      success: true,
      total: result.rows.length,
      notes: result.rows
    });

  } catch (error) {
    console.error('Get property notes error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to load property notes',
      error: error.message
    });
  }
};


const updatePropertyNote = async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;

    if (!note) {
      return res.status(400).json({
        success: false,
        message: 'note is required'
      });
    }

    const result = await pool.query(
      `
      UPDATE property_notes
      SET note = $1
      WHERE id = $2
      RETURNING *
      `,
      [
        note.trim(),
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Property note not found'
      });
    }

    return res.json({
      success: true,
      message: 'Property note updated successfully',
      note: result.rows[0]
    });

  } catch (error) {
    console.error('Update property note error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to update property note',
      error: error.message
    });
  }
};


const deletePropertyNote = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      DELETE FROM property_notes
      WHERE id = $1
      RETURNING *
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Property note not found'
      });
    }

    return res.json({
      success: true,
      message: 'Property note deleted successfully'
    });

  } catch (error) {
    console.error('Delete property note error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to delete property note',
      error: error.message
    });
  }
};


module.exports = {
  createPropertyNote,
  getPropertyNotes,
  updatePropertyNote,
  deletePropertyNote
};