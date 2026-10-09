const pool = require('../config/database');

const createServicePartner = async (req, res) => {
  try {
    const {
      partner_name,
      service_type,
      phone,
      email,
      company_name,
      city,
      address,
      notes,
      status = 'ACTIVE'
    } = req.body;

    if (!partner_name || !service_type) {
      return res.status(400).json({
        success: false,
        message: 'partner_name and service_type are required'
      });
    }

    const result = await pool.query(
      `
      INSERT INTO service_partners (
        partner_name,
        service_type,
        phone,
        email,
        company_name,
        city,
        address,
        notes,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
      `,
      [
        partner_name.trim(),
        service_type.trim(),
        phone || null,
        email || null,
        company_name || null,
        city || null,
        address || null,
        notes || null,
        String(status).toUpperCase()
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Service partner created successfully',
      service_partner: result.rows[0]
    });

  } catch (error) {
    console.error('Create service partner error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to create service partner',
      error: error.message
    });
  }
};


const getServicePartners = async (req, res) => {
  try {
    const {
      service_type,
      status,
      search
    } = req.query;

    const values = [];
    const conditions = [];

    if (service_type) {
      values.push(String(service_type).toLowerCase());

      conditions.push(
        `LOWER(service_type) = $${values.length}`
      );
    }

    if (status) {
      values.push(String(status).toUpperCase());

      conditions.push(
        `status = $${values.length}`
      );
    }

    if (search) {
      values.push(`%${String(search).toLowerCase()}%`);

      conditions.push(`
        (
          LOWER(partner_name) LIKE $${values.length}
          OR LOWER(COALESCE(company_name, '')) LIKE $${values.length}
          OR LOWER(COALESCE(phone, '')) LIKE $${values.length}
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
      FROM service_partners
      ${whereClause}
      ORDER BY created_at DESC
      `,
      values
    );

    return res.json({
      success: true,
      total: result.rows.length,
      service_partners: result.rows
    });

  } catch (error) {
    console.error('Get service partners error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to load service partners',
      error: error.message
    });
  }
};


const getServicePartnerById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT *
      FROM service_partners
      WHERE id = $1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Service partner not found'
      });
    }

    return res.json({
      success: true,
      service_partner: result.rows[0]
    });

  } catch (error) {
    console.error('Get service partner error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to load service partner',
      error: error.message
    });
  }
};


const updateServicePartner = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      partner_name,
      service_type,
      phone,
      email,
      company_name,
      city,
      address,
      notes,
      status
    } = req.body;

    const result = await pool.query(
      `
      UPDATE service_partners
      SET
        partner_name = COALESCE($1, partner_name),
        service_type = COALESCE($2, service_type),
        phone = COALESCE($3, phone),
        email = COALESCE($4, email),
        company_name = COALESCE($5, company_name),
        city = COALESCE($6, city),
        address = COALESCE($7, address),
        notes = COALESCE($8, notes),
        status = COALESCE($9, status),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $10
      RETURNING *
      `,
      [
        partner_name || null,
        service_type || null,
        phone || null,
        email || null,
        company_name || null,
        city || null,
        address || null,
        notes || null,
        status ? String(status).toUpperCase() : null,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Service partner not found'
      });
    }

    return res.json({
      success: true,
      message: 'Service partner updated successfully',
      service_partner: result.rows[0]
    });

  } catch (error) {
    console.error('Update service partner error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to update service partner',
      error: error.message
    });
  }
};


const deleteServicePartner = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      DELETE FROM service_partners
      WHERE id = $1
      RETURNING *
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Service partner not found'
      });
    }

    return res.json({
      success: true,
      message: 'Service partner deleted successfully'
    });

  } catch (error) {
    console.error('Delete service partner error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to delete service partner',
      error: error.message
    });
  }
};


module.exports = {
  createServicePartner,
  getServicePartners,
  getServicePartnerById,
  updateServicePartner,
  deleteServicePartner
};