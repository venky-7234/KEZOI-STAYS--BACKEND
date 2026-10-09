const pool = require('../config/database');


// ======================================================
// CREATE MAINTENANCE REQUEST
// ======================================================

const createMaintenanceRequest = async (req, res) => {
  try {
    const {
      property_id,
      asset_id,
      service_partner_id,
      title,
      description,
      priority = 'MEDIUM',
      maintenance_status = 'OPEN',
      estimated_cost = 0,
      actual_cost = 0,
      scheduled_date,
      completed_at,
      notes
    } = req.body;

    if (!property_id || !title) {
      return res.status(400).json({
        success: false,
        message: 'property_id and title are required'
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

    if (asset_id) {
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
          message: 'Asset does not belong to this property'
        });
      }
    }

    if (service_partner_id) {
      const partnerResult = await pool.query(
        `
        SELECT id
        FROM service_partners
        WHERE id = $1
        `,
        [service_partner_id]
      );

      if (partnerResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Service partner not found'
        });
      }
    }

    const result = await pool.query(
      `
      INSERT INTO maintenance_requests (
        property_id,
        asset_id,
        service_partner_id,
        title,
        description,
        priority,
        maintenance_status,
        estimated_cost,
        actual_cost,
        scheduled_date,
        completed_at,
        notes,
        created_by
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,
        $8,$9,$10,$11,$12,$13
      )
      RETURNING *
      `,
      [
        property_id,
        asset_id || null,
        service_partner_id || null,
        title.trim(),
        description || null,
        String(priority).toUpperCase(),
        String(maintenance_status).toUpperCase(),
        Number(estimated_cost) || 0,
        Number(actual_cost) || 0,
        scheduled_date || null,
        completed_at || null,
        notes || null,
        req.user.id
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Maintenance request created successfully',
      maintenance: result.rows[0]
    });

  } catch (error) {
    console.error('Create maintenance error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to create maintenance request',
      error: error.message
    });
  }
};


// ======================================================
// GET MAINTENANCE REQUESTS
// ======================================================

const getMaintenanceRequests = async (req, res) => {
  try {
    const {
      property_id,
      status,
      priority
    } = req.query;

    const values = [];
    const conditions = [];

    if (property_id) {
      values.push(property_id);

      conditions.push(
        `m.property_id = $${values.length}`
      );
    }

    if (status) {
      values.push(String(status).toUpperCase());

      conditions.push(
        `m.maintenance_status = $${values.length}`
      );
    }

    if (priority) {
      values.push(String(priority).toUpperCase());

      conditions.push(
        `m.priority = $${values.length}`
      );
    }

    const whereClause =
      conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : '';

    const result = await pool.query(
      `
      SELECT
        m.*,

        p.property_code,
        p.property_name,

        a.asset_name,

        sp.partner_name,
        sp.service_type,

        u.full_name AS created_by_name

      FROM maintenance_requests m

      JOIN properties p
        ON p.id = m.property_id

      LEFT JOIN property_assets a
        ON a.id = m.asset_id

      LEFT JOIN service_partners sp
        ON sp.id = m.service_partner_id

      LEFT JOIN users u
        ON u.id = m.created_by

      ${whereClause}

      ORDER BY m.created_at DESC
      `,
      values
    );

    return res.json({
      success: true,
      total: result.rows.length,
      maintenance: result.rows
    });

  } catch (error) {
    console.error('Get maintenance error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to load maintenance requests',
      error: error.message
    });
  }
};


// ======================================================
// GET MAINTENANCE BY ID
// ======================================================

const getMaintenanceById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT
        m.*,

        p.property_code,
        p.property_name,

        a.asset_name,

        sp.partner_name,
        sp.service_type,
        sp.phone AS service_partner_phone,

        u.full_name AS created_by_name

      FROM maintenance_requests m

      JOIN properties p
        ON p.id = m.property_id

      LEFT JOIN property_assets a
        ON a.id = m.asset_id

      LEFT JOIN service_partners sp
        ON sp.id = m.service_partner_id

      LEFT JOIN users u
        ON u.id = m.created_by

      WHERE m.id = $1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Maintenance request not found'
      });
    }

    return res.json({
      success: true,
      maintenance: result.rows[0]
    });

  } catch (error) {
    console.error('Get maintenance detail error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to load maintenance request',
      error: error.message
    });
  }
};


// ======================================================
// UPDATE MAINTENANCE
// ======================================================

const updateMaintenance = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      service_partner_id,
      title,
      description,
      priority,
      maintenance_status,
      estimated_cost,
      actual_cost,
      scheduled_date,
      completed_at,
      notes
    } = req.body;

    let finalCompletedAt = completed_at || null;

    if (
      maintenance_status &&
      String(maintenance_status).toUpperCase() === 'COMPLETED' &&
      !completed_at
    ) {
      finalCompletedAt = new Date();
    }

    const result = await pool.query(
      `
      UPDATE maintenance_requests
      SET
        service_partner_id =
          COALESCE($1, service_partner_id),

        title =
          COALESCE($2, title),

        description =
          COALESCE($3, description),

        priority =
          COALESCE($4, priority),

        maintenance_status =
          COALESCE($5, maintenance_status),

        estimated_cost =
          COALESCE($6, estimated_cost),

        actual_cost =
          COALESCE($7, actual_cost),

        scheduled_date =
          COALESCE($8, scheduled_date),

        completed_at =
          COALESCE($9, completed_at),

        notes =
          COALESCE($10, notes),

        updated_at =
          CURRENT_TIMESTAMP

      WHERE id = $11

      RETURNING *
      `,
      [
        service_partner_id ?? null,
        title || null,
        description || null,
        priority
          ? String(priority).toUpperCase()
          : null,
        maintenance_status
          ? String(maintenance_status).toUpperCase()
          : null,
        estimated_cost ?? null,
        actual_cost ?? null,
        scheduled_date || null,
        finalCompletedAt,
        notes || null,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Maintenance request not found'
      });
    }

    return res.json({
      success: true,
      message: 'Maintenance request updated successfully',
      maintenance: result.rows[0]
    });

  } catch (error) {
    console.error('Update maintenance error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to update maintenance request',
      error: error.message
    });
  }
};


// ======================================================
// PROPERTY MAINTENANCE SUMMARY
// ======================================================

const getPropertyMaintenanceSummary = async (req, res) => {
  try {
    const { propertyId } = req.params;

    const result = await pool.query(
      `
      SELECT

        COUNT(*)::int
          AS total_requests,

        COUNT(*) FILTER (
          WHERE maintenance_status = 'OPEN'
        )::int
          AS open_requests,

        COUNT(*) FILTER (
          WHERE maintenance_status = 'IN_PROGRESS'
        )::int
          AS in_progress,

        COUNT(*) FILTER (
          WHERE maintenance_status = 'COMPLETED'
        )::int
          AS completed,

        COUNT(*) FILTER (
          WHERE priority = 'HIGH'
        )::int
          AS high_priority,

        COALESCE(
          SUM(actual_cost),
          0
        ) AS total_maintenance_cost

      FROM maintenance_requests

      WHERE property_id = $1
      `,
      [propertyId]
    );

    return res.json({
      success: true,
      summary: {
        ...result.rows[0],
        total_maintenance_cost:
          Number(
            result.rows[0]
              .total_maintenance_cost || 0
          )
      }
    });

  } catch (error) {
    console.error('Maintenance summary error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to load maintenance summary',
      error: error.message
    });
  }
};


// ======================================================
// DELETE MAINTENANCE REQUEST
// ======================================================

const deleteMaintenance = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      DELETE FROM maintenance_requests
      WHERE id = $1
      RETURNING *
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Maintenance request not found'
      });
    }

    return res.json({
      success: true,
      message: 'Maintenance request deleted successfully'
    });

  } catch (error) {
    console.error('Delete maintenance error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to delete maintenance request',
      error: error.message
    });
  }
};


module.exports = {
  createMaintenanceRequest,
  getMaintenanceRequests,
  getMaintenanceById,
  updateMaintenance,
  getPropertyMaintenanceSummary,
  deleteMaintenance
};