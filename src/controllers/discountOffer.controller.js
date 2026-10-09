const pool = require('../config/database');
const { validatePhoneNumber, INVALID_MOBILE_MESSAGE } = require('../utils/phoneValidator');

const saveDiscountOffer = async (req, res) => {
  try {
    const phoneCountry = req.body.phone_country_code || req.body.country_code || 'IN';
    const mobile = validatePhoneNumber(req.body.mobile_number, phoneCountry);
    const percentage = Number(req.body.discount_percentage);
    if (!mobile.valid) return res.status(400).json({ success: false, message: INVALID_MOBILE_MESSAGE });
    if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
      return res.status(400).json({ success: false, message: 'Discount percentage must be greater than 0 and no more than 100' });
    }
    const validUntil = req.body.valid_until || null;
    if (validUntil && Number.isNaN(Date.parse(validUntil))) {
      return res.status(400).json({ success: false, message: 'valid_until must be a valid date and time' });
    }
    if (validUntil && Date.parse(validUntil) <= Date.now()) {
      return res.status(400).json({ success: false, message: 'valid_until must be in the future' });
    }

    const result = await pool.query(
      `INSERT INTO mobile_discount_offers
        (mobile_number, discount_percentage, reason, status, valid_until, created_by, updated_by)
       VALUES ($1, $2, $3, 'ACTIVE', $4, $5, $5)
       ON CONFLICT (mobile_number) DO UPDATE SET
         discount_percentage = EXCLUDED.discount_percentage,
         reason = EXCLUDED.reason,
         status = 'ACTIVE',
         valid_from = CURRENT_TIMESTAMP,
         valid_until = EXCLUDED.valid_until,
         updated_by = EXCLUDED.updated_by,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [mobile.normalizedNumber, percentage, String(req.body.reason || '').trim() || null, validUntil, req.user.id]
    );
    return res.status(201).json({ success: true, message: 'Mobile discount saved', discount_offer: result.rows[0] });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Unable to save mobile discount', error: error.message });
  }
};

const listDiscountOffers = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.*, c.full_name AS created_by_name, u.full_name AS updated_by_name
         FROM mobile_discount_offers d
         LEFT JOIN users c ON c.id = d.created_by
         LEFT JOIN users u ON u.id = d.updated_by
        ORDER BY d.updated_at DESC`
    );
    return res.json({ success: true, total: result.rows.length, discount_offers: result.rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Unable to load mobile discounts', error: error.message });
  }
};

const deactivateDiscountOffer = async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE mobile_discount_offers SET status = 'INACTIVE', updated_by = $1,
              updated_at = CURRENT_TIMESTAMP WHERE id = $2::bigint RETURNING *`,
      [req.user.id, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Discount offer not found' });
    return res.json({ success: true, message: 'Mobile discount deactivated', discount_offer: result.rows[0] });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Unable to deactivate mobile discount', error: error.message });
  }
};

module.exports = { saveDiscountOffer, listDiscountOffers, deactivateDiscountOffer };
