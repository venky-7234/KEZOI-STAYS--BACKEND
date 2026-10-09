const pool = require('../config/database');


// ======================================================
// ADD GUEST NOTE
// ======================================================

const addGuestNote = async (req, res) => {
  try {
    const { guestId } = req.params;

    const { note } = req.body;

    if (!note) {
      return res.status(400).json({
        success: false,
        message: 'Note is required'
      });
    }

    const guestResult = await pool.query(
      `
      SELECT id
      FROM guests
      WHERE id = $1
      `,
      [guestId]
    );

    if (guestResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Guest not found'
      });
    }

    const result = await pool.query(
      `
      INSERT INTO guest_notes (
        guest_id,
        note,
        created_by
      )
      VALUES (
        $1,
        $2,
        $3
      )
      RETURNING *
      `,
      [
        guestId,
        note,
        req.user.id
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Guest note added successfully',
      note: result.rows[0]
    });

  } catch (error) {
    console.error(
      'Add guest note error:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Unable to add guest note',
      error: error.message
    });
  }
};


// ======================================================
// GET GUEST NOTES
// ======================================================

const getGuestNotes = async (req, res) => {
  try {
    const { guestId } = req.params;

    const result = await pool.query(
      `
      SELECT
        gn.*,
        u.full_name AS created_by_name

      FROM guest_notes gn

      LEFT JOIN users u
        ON u.id = gn.created_by

      WHERE gn.guest_id = $1

      ORDER BY gn.created_at DESC
      `,
      [guestId]
    );

    return res.json({
      success: true,
      total: result.rows.length,
      notes: result.rows
    });

  } catch (error) {
    console.error(
      'Get guest notes error:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Unable to load guest notes',
      error: error.message
    });
  }
};


// ======================================================
// ADD COMMUNICATION LOG
// ======================================================

const addCommunicationLog = async (req, res) => {
  try {
    const { guestId } = req.params;

    const {
      channel,
      direction,
      message
    } = req.body;

    if (!channel) {
      return res.status(400).json({
        success: false,
        message: 'Communication channel is required'
      });
    }

    const guestResult = await pool.query(
      `
      SELECT id
      FROM guests
      WHERE id = $1
      `,
      [guestId]
    );

    if (guestResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Guest not found'
      });
    }

    const result = await pool.query(
      `
      INSERT INTO communication_logs (
        guest_id,
        channel,
        direction,
        message,
        handled_by
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5
      )
      RETURNING *
      `,
      [
        guestId,
        String(channel).toUpperCase(),
        direction
          ? String(direction).toUpperCase()
          : 'OUTBOUND',
        message || null,
        req.user.id
      ]
    );

    await pool.query(
      `
      UPDATE guests
      SET
        last_contact_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      `,
      [guestId]
    );

    return res.status(201).json({
      success: true,
      message: 'Communication log added successfully',
      communication: result.rows[0]
    });

  } catch (error) {
    console.error(
      'Add communication log error:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Unable to add communication log',
      error: error.message
    });
  }
};


// ======================================================
// GET COMMUNICATION LOGS
// ======================================================

const getCommunicationLogs = async (req, res) => {
  try {
    const { guestId } = req.params;

    const result = await pool.query(
      `
      SELECT
        cl.*,
        u.full_name AS handled_by_name

      FROM communication_logs cl

      LEFT JOIN users u
        ON u.id = cl.handled_by

      WHERE cl.guest_id = $1

      ORDER BY cl.created_at DESC
      `,
      [guestId]
    );

    return res.json({
      success: true,
      total: result.rows.length,
      communications: result.rows
    });

  } catch (error) {
    console.error(
      'Get communication logs error:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Unable to load communication logs',
      error: error.message
    });
  }
};


// ======================================================
// GET FULL GUEST TIMELINE
// ======================================================

const getGuestTimeline = async (req, res) => {
  try {
    const { guestId } = req.params;

    const result = await pool.query(
      `
      SELECT
        'NOTE' AS activity_type,
        id,
        note AS description,
        created_at

      FROM guest_notes

      WHERE guest_id = $1


      UNION ALL


      SELECT
        'COMMUNICATION' AS activity_type,
        id,

        CONCAT(
          channel,
          ' - ',
          COALESCE(message, '')
        ) AS description,

        created_at

      FROM communication_logs

      WHERE guest_id = $1


      UNION ALL


      SELECT
        'ENQUIRY' AS activity_type,
        id,

        CONCAT(
          'Enquiry status: ',
          status
        ) AS description,

        created_at

      FROM enquiries

      WHERE guest_id = $1


      UNION ALL


      SELECT
        'BOOKING' AS activity_type,
        id,

        CONCAT(
          'Booking ',
          booking_reference,
          ' - ',
          booking_status
        ) AS description,

        created_at

      FROM bookings

      WHERE guest_id = $1


      ORDER BY created_at DESC
      `,
      [guestId]
    );

    return res.json({
      success: true,
      timeline: result.rows
    });

  } catch (error) {
    console.error(
      'Get guest timeline error:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Unable to load guest timeline',
      error: error.message
    });
  }
};


module.exports = {
  addGuestNote,
  getGuestNotes,
  addCommunicationLog,
  getCommunicationLogs,
  getGuestTimeline
};