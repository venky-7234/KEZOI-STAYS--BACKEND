const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const { validatePhoneNumber, INVALID_MOBILE_MESSAGE } = require('../utils/phoneValidator');
const { findAvailableProperties, parseStay } = require('../services/availability.service');
const { triggerEnquiryWhatsAppAutomation } = require('../services/whatsapp.service');

const availability = async (req, res) => {
  try {
    const result = await findAvailableProperties(pool, req.body);
    if (result.error) return res.status(result.status).json({ success: false, message: result.error });
    return res.json({ success: true, quoted_at: new Date().toISOString(), hold_created: false, ...result });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Unable to search availability' });
  }
};

const createEnquiry = async (req, res) => {
  const client = await pool.connect();
  try {
    const key = String(req.headers['idempotency-key'] || '').trim();
    if (!/^[A-Za-z0-9:._-]{16,200}$/.test(key)) {
      return res.status(400).json({ success: false, message: 'A valid Idempotency-Key header is required' });
    }
    const input = req.body || {};
    const required = ['property_id', 'check_in', 'check_out', 'guest_name', 'guest_email', 'whatsapp_number'];
    const missing = required.filter(name => !String(input[name] || '').trim());
    if (missing.length) return res.status(400).json({ success: false, message: `Missing required fields: ${missing.join(', ')}` });
    const stay = parseStay({ ...input, adults: input.adults ?? input.guests, children: input.children ?? 0 });
    if (stay.error) return res.status(400).json({ success: false, message: stay.error });
    const phone = validatePhoneNumber(input.whatsapp_number, input.country_code || 'IN');
    if (!phone.valid) return res.status(400).json({ success: false, message: INVALID_MOBILE_MESSAGE });
    const email = String(input.guest_email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, message: 'A valid email is required' });
    const hash = crypto.createHash('sha256').update(JSON.stringify({ ...input, whatsapp_number: phone.normalizedNumber })).digest('hex');

    await client.query('BEGIN');
    const prior = await client.query('SELECT e.*, g.full_name, g.email, g.whatsapp_number FROM enquiries e JOIN guests g ON g.id=e.guest_id WHERE e.integration_idempotency_key=$1 FOR UPDATE', [key]);
    if (prior.rows.length) {
      if (prior.rows[0].integration_request_hash !== hash) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, message: 'Idempotency key was already used for a different request' });
      }
      await client.query('COMMIT');
      return res.json(buildEnquiryResponse(prior.rows[0], true));
    }

    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [input.property_id]);
    const available = await findAvailableProperties(client, { ...input, adults: input.adults ?? input.guests, children: input.children ?? 0 });
    if (available.error) { await client.query('ROLLBACK'); return res.status(available.status).json({ success: false, message: available.error }); }
    const property = available.properties.find(item => String(item.id) === String(input.property_id));
    if (!property) { await client.query('ROLLBACK'); return res.status(409).json({ success: false, message: 'Property is not available for the selected stay' }); }

    let guest = (await client.query('SELECT * FROM guests WHERE LOWER(email)=$1 OR whatsapp_number=$2 ORDER BY id LIMIT 1', [email, phone.normalizedNumber])).rows[0];
    if (!guest) {
      guest = (await client.query(`INSERT INTO guests(full_name,email,phone,whatsapp_number,country,source,first_enquiry_at,last_contact_at,guest_status)
        VALUES($1,$2,$3,$3,CASE WHEN $3 LIKE '+91%' THEN 'India' ELSE 'International' END,'WHATSAPP',NOW(),NOW(),'ACTIVE') RETURNING *`,
        [String(input.guest_name).trim(), email, phone.normalizedNumber])).rows[0];
    }
    const q = property.quote;
    const enquiry = (await client.query(`INSERT INTO enquiries(
      guest_id,property_id,source,check_in,check_out,adults,children,infants,pets,guest_message,
      quoted_amount,quoted_base_amount,extra_guest_amount,quoted_total_amount,status,document_verification_status,
      original_amount,discount_percentage,discount_amount,taxable_amount,gst_rate,cgst_amount,sgst_amount,igst_amount,gst_amount,currency,price_includes_gst,
      integration_idempotency_key,integration_request_hash)
      VALUES($1,$2,'WHATSAPP',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$10,'NEW','PENDING',$13,0,0,$14,$15,$16,$17,0,$18,$19,FALSE,$20,$21) RETURNING *`,
      [guest.id, property.id, stay.check_in, stay.check_out, stay.adults, stay.children, stay.infants, stay.pets,
       input.special_requests || null, q.total_amount, q.base_amount, q.extra_guest_amount, q.taxable_amount,
       q.taxable_amount, q.gst_rate, q.cgst_amount, q.sgst_amount, q.gst_amount, q.currency, key, hash])).rows[0];
    await client.query('COMMIT');
    triggerEnquiryWhatsAppAutomation({ event: 'BOOKING_REQUEST_RECEIVED', enquiryId: enquiry.id });
    return res.status(201).json(buildEnquiryResponse(enquiry, false));
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ success: false, message: 'Duplicate enquiry submission' });
    console.error('Integration enquiry error:', error);
    return res.status(500).json({ success: false, message: 'Unable to create enquiry' });
  } finally { client.release(); }
};

const buildEnquiryResponse = (row, replayed) => {
  const token = jwt.sign({ purpose: 'IDENTITY_DOCUMENT_UPLOAD', enquiry_id: row.id, guest_id: row.guest_id }, process.env.JWT_SECRET, { expiresIn: '24h' });
  const base = process.env.WEBSITE_APPLICATION_URL || 'https://www.kezoistays.com';
  const separator = base.includes('?') ? '&' : '?';
  return {
    success: true,
    replayed,
    enquiry: { reference: `APP-${row.id}`, id: row.id, status: row.status, document_status: row.document_verification_status },
    identity_document: { required: true, expires_in_seconds: 86400, handoff_url: `${base}${separator}enquiry=${row.id}&upload_token=${encodeURIComponent(token)}` }
  };
};

module.exports = { availability, createEnquiry };
