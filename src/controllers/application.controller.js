const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const {
  normalizeEmail,
  isValidEmail,
  parsePositiveInteger,
  parseDateOnly
} = require('../utils/applicationValidation');
const {
  ContactValidationError,
  validateApplicationContacts
} = require('../services/contactValidation.service');
const { validatePhoneNumber, INVALID_MOBILE_MESSAGE } = require('../utils/phoneValidator');
const { notifyApplicationSubmitted } = require('../services/applicationNotification.service');
const { calculateExclusiveGst, calculateAuthoritativeQuote } = require('../utils/gstCalculator');

const DOCUMENT_TYPES = ['AADHAAR_CARD', 'PASSPORT', 'DRIVING_LICENCE'];
const DOCUMENT_TYPE_ALIASES = {
  AADHAAR: 'AADHAAR_CARD',
  AADHAR: 'AADHAAR_CARD',
  AADHAR_CARD: 'AADHAAR_CARD',
  DRIVING_LICENSE: 'DRIVING_LICENCE',
  DRIVER_LICENCE: 'DRIVING_LICENCE',
  DRIVER_LICENSE: 'DRIVING_LICENCE'
};
const ACTIVE_BOOKING_STATUSES = ['HOLD', 'CONFIRMED', 'CHECKED_IN'];

const formatDateOnly = value => {
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const validateStay = ({ check_in, check_out, adults, children, infants, pets }) => {
  const checkIn = parseDateOnly(check_in);
  const checkOut = parseDateOnly(check_out);
  const parsed = {
    adults: parsePositiveInteger(adults, 1),
    children: parsePositiveInteger(children, 0),
    infants: parsePositiveInteger(infants, 0),
    pets: parsePositiveInteger(pets, 0)
  };

  if (!checkIn || !checkOut || checkOut <= checkIn) {
    return { error: 'Valid check-in and check-out dates are required; check-out must be later' };
  }
  if (Object.values(parsed).some(value => value === null) || parsed.adults < 1) {
    return { error: 'Adults must be at least 1 and all guest counts must be whole numbers' };
  }

  return {
    ...parsed,
    checkIn,
    checkOut,
    nights: Math.round((checkOut - checkIn) / 86400000),
    pricedGuests: parsed.adults + parsed.children,
    totalOccupants: parsed.adults + parsed.children + parsed.infants
  };
};

const getActiveMobileDiscount = async (db, mobileNumber) => {
  if (!mobileNumber) return null;
  const result = await db.query(
    `SELECT id, discount_percentage, reason, valid_until
       FROM mobile_discount_offers
      WHERE mobile_number = $1 AND status = 'ACTIVE'
        AND valid_from <= CURRENT_TIMESTAMP
        AND (valid_until IS NULL OR valid_until > CURRENT_TIMESTAMP)
      LIMIT 1`,
    [mobileNumber]
  );
  return result.rows[0] || null;
};

const getPropertyAndQuote = async (db, propertyId, stay, mobileNumber = null) => {
  const propertyResult = await db.query(
    `SELECT id, property_code, property_name, area, city, status, max_guests,
            base_price, included_guests, extra_guest_price, currency,
            gst_enabled, gst_rate, price_includes_gst, updated_at
       FROM properties WHERE id = $1`,
    [propertyId]
  );
  if (!propertyResult.rows.length) return { status: 404, error: 'Property not found' };

  const property = propertyResult.rows[0];
  if (property.status !== 'ACTIVE') return { status: 409, error: 'Property is not active' };
  const totalOccupants = stay.totalOccupants ?? stay.total_occupants ?? (stay.adults + stay.children + stay.infants);
  if (property.max_guests && totalOccupants > Number(property.max_guests)) {
    return { status: 400, error: `This property allows a maximum of ${property.max_guests} guests` };
  }

  const conflicts = await db.query(
    `SELECT 'BOOKING' AS source, check_in AS start_date, check_out AS end_date
       FROM bookings
      WHERE property_id = $1::bigint AND booking_status = ANY($4::text[])
        AND check_in < $3::date AND check_out > $2::date
      UNION ALL
     SELECT 'BLOCK' AS source, start_date, end_date
       FROM property_blocks
      WHERE property_id = $1::bigint AND start_date < $3::date AND end_date > $2::date`,
    [propertyId, stay.checkIn, stay.checkOut, ACTIVE_BOOKING_STATUSES]
  );
  if (conflicts.rows.length) {
    return { status: 409, error: 'Property is unavailable for one or more selected dates' };
  }

  if (property.price_includes_gst) {
    return { status: 500, error: 'GST-inclusive property pricing is not supported by this pricing configuration' };
  }

  const offer = await getActiveMobileDiscount(db, mobileNumber);
  const quote = calculateAuthoritativeQuote({
    property,
    stay: {
      ...stay,
      nights: stay.nights,
      priced_guests: stay.pricedGuests ?? stay.priced_guests
    },
    discountOffer: offer
  });

  return {
    property,
    quote
  };
};

const listPublicProperties = async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, property_code, property_name, property_type, area, city, bedrooms,
              bathrooms, max_guests, base_price, included_guests, extra_guest_price,
              currency, gst_enabled, gst_rate, price_includes_gst, updated_at
         FROM properties WHERE status = 'ACTIVE' ORDER BY property_name`
    );
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      total: result.rows.length,
      prices_refreshed_at: new Date().toISOString(),
      properties: result.rows
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Unable to load properties', error: error.message });
  }
};

const getUnavailableDates = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 'BOOKING' AS source, check_in AS start_date, check_out AS end_date,
              CASE WHEN payment_status = 'PAID' THEN 'BOOKED' ELSE 'RESERVED' END AS availability_status,
              booking_status::text AS booking_status, payment_status::text AS payment_status,
              NULL::text AS block_type, NULL::text AS reason
         FROM bookings
        WHERE property_id = $1 AND booking_status = ANY($2::text[])
          AND check_out >= CURRENT_DATE
       UNION ALL
       SELECT 'BLOCK' AS source, start_date, end_date, 'BOOKED' AS availability_status,
              NULL::text AS booking_status, NULL::text AS payment_status,
              block_type::text AS block_type, reason::text
         FROM property_blocks
        WHERE property_id = $1 AND end_date >= CURRENT_DATE
        ORDER BY start_date`,
      [req.params.id, ACTIVE_BOOKING_STATUSES]
    );

    const blockedDates = new Set();
    for (const range of result.rows) {
      const startValue = formatDateOnly(range.start_date);
      const endValue = formatDateOnly(range.end_date);
      const start = new Date(`${startValue}T00:00:00.000Z`);
      const end = new Date(`${endValue}T00:00:00.000Z`);
      for (let date = start; date < end; date = new Date(date.getTime() + 86400000)) {
        blockedDates.add(date.toISOString().slice(0, 10));
      }
    }

    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      property_id: req.params.id,
      unavailable_dates: result.rows.map(range => ({
        ...range,
        start_date: formatDateOnly(range.start_date),
        end_date: formatDateOnly(range.end_date)
      })),
      blocked_dates: [...blockedDates].sort()
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Unable to load unavailable dates', error: error.message });
  }
};

const getQuote = async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const input = req.method === 'GET'
      ? { ...req.query, property_id: req.params.id || req.query.property_id }
      : req.body;
    if (!input.property_id) return res.status(400).json({ success: false, message: 'property_id is required' });
    const stay = validateStay(input);
    if (stay.error) return res.status(400).json({ success: false, message: stay.error });
    let mobileNumber = null;
    if (input.mobile_number || input.whatsapp_number || input.phone) {
      const mobile = validatePhoneNumber(
        input.mobile_number || input.whatsapp_number || input.phone,
        input.phone_country_code || input.whatsapp_country_code || input.country_code || 'IN'
      );
      if (!mobile.valid) return res.status(400).json({ success: false, message: INVALID_MOBILE_MESSAGE });
      mobileNumber = mobile.normalizedNumber;
    }
    const result = await getPropertyAndQuote(pool, input.property_id, stay, mobileNumber);
    if (result.error) return res.status(result.status).json({ success: false, message: result.error });
    res.json({
      success: true,
      priced_at: new Date().toISOString(),
      property: result.property,
      guests: stay,
      quote: result.quote
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Unable to calculate quote', error: error.message });
  }
};

const requestVerification = async (req, res) => {
  try {
    const email = req.body.email || (String(req.body.channel || '').toUpperCase() === 'EMAIL' ? req.body.value || req.body.destination : null);
    const phone = req.body.phone || req.body.whatsapp_number || (String(req.body.channel || '').toUpperCase() !== 'EMAIL' ? req.body.value || req.body.destination : null);
    if (!email || !phone) {
      return res.status(400).json({ success: false, message: 'Email and phone number are required' });
    }
    const phoneCountry = req.body.phone_country_code || req.body.whatsapp_country_code || req.body.country_code || 'IN';
    const validation = await validateApplicationContacts({ email, phone, phoneCountry });
    const valid = validation.email.valid && validation.phone.valid;
    const providerVerified = valid && validation.email.verified !== false;
    res.status(valid ? 200 : 422).json({
      success: valid,
      verified: providerVerified,
      message: valid
        ? providerVerified
          ? 'Email and phone number are valid'
          : 'Contact format is valid; email provider verification is temporarily deferred'
        : 'Email or phone number could not be validated',
      validation
    });
  } catch (error) {
    console.error('Contact validation error:', error);
    res.status(error instanceof ContactValidationError ? error.status : 500)
      .json({ success: false, message: error.message || 'Unable to validate contact details' });
  }
};

const confirmVerification = async (req, res) => {
  res.status(410).json({
    success: false,
    message: 'OTP confirmation has been removed; validate email and phone using /verification/request'
  });
};

const submitApplication = async (req, res) => {
  const client = await pool.connect();
  let completed = false;
  try {
    const required = ['property_id', 'full_name', 'email', 'whatsapp_number', 'check_in', 'check_out', 'document_type'];
    const missing = required.filter(field => !String(req.body[field] || '').trim());
    if (missing.length || !req.file) {
      return res.status(400).json({ success: false, message: `Missing required fields: ${[...missing, ...(!req.file ? ['identity_document'] : [])].join(', ')}` });
    }

    const email = normalizeEmail(req.body.email);
    const phoneCountry = req.body.phone_country_code || req.body.whatsapp_country_code || req.body.country_code || 'IN';
    const whatsappValidation = validatePhoneNumber(req.body.whatsapp_number, phoneCountry);
    const phoneValidation = validatePhoneNumber(req.body.phone || req.body.whatsapp_number, phoneCountry);
    if (!whatsappValidation.valid || !phoneValidation.valid) {
      return res.status(400).json({ success: false, message: INVALID_MOBILE_MESSAGE });
    }
    const whatsapp = whatsappValidation.normalizedNumber;
    const phone = phoneValidation.normalizedNumber;
    const referralName = String(req.body.referral_name || '').trim() || null;
    const referralMobileInput = String(req.body.referral_mobile || '').trim();
    let referralMobile = null;
    if (referralName || referralMobileInput) {
      if (!referralName || !referralMobileInput) {
        return res.status(400).json({ success: false, message: 'Referral name and mobile number must be provided together' });
      }
      const referralValidation = validatePhoneNumber(referralMobileInput, phoneCountry);
      if (!referralValidation.valid) {
        return res.status(400).json({ success: false, message: `Referral ${INVALID_MOBILE_MESSAGE.toLowerCase()}` });
      }
      referralMobile = referralValidation.normalizedNumber;
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'A valid email is required' });
    }
    const contactValidation = await validateApplicationContacts({ email, phone: whatsapp, phoneCountry });
    if (!contactValidation.email.valid || !contactValidation.phone.valid) {
      return res.status(422).json({
        success: false,
        message: 'Email or phone number could not be validated',
        validation: contactValidation
      });
    }

    const submittedDocumentType = String(req.body.document_type).trim().toUpperCase().replace(/[\s-]+/g, '_');
    const documentType = DOCUMENT_TYPE_ALIASES[submittedDocumentType] || submittedDocumentType;
    const applicationSource = String(req.body.application_source || 'WEBSITE').toUpperCase() === 'TG-0001' ? 'TG-0001' : 'WEBSITE';
    if (!DOCUMENT_TYPES.includes(documentType)) {
      return res.status(400).json({
        success: false,
        message: 'Document type must be Aadhaar card, passport or driving licence'
      });
    }
    const stay = validateStay(req.body);
    if (stay.error) return res.status(400).json({ success: false, message: stay.error });

    await client.query('BEGIN');
    const pricing = await getPropertyAndQuote(client, req.body.property_id, stay, whatsapp);
    if (pricing.error) {
      await client.query('ROLLBACK');
      return res.status(pricing.status).json({ success: false, message: pricing.error });
    }

    const existing = await client.query(
      `SELECT * FROM guests WHERE LOWER(email) = $1 OR whatsapp_number = $2 ORDER BY id LIMIT 1`,
      [email, whatsapp]
    );
    let guest;
    if (existing.rows.length) {
      const updated = await client.query(
        `UPDATE guests SET full_name=$1::varchar, email=$2::varchar, whatsapp_number=$3::varchar,
           phone=COALESCE($4::varchar, phone),
           email_verified_at=CASE WHEN $6::boolean THEN NOW() ELSE email_verified_at END,
           whatsapp_verified_at=NOW(),
           referral_name=COALESCE($7::varchar, referral_name),
           referral_mobile=COALESCE($8::varchar, referral_mobile),
           last_contact_at=NOW(), updated_at=NOW() WHERE id=$5::bigint RETURNING *`,
        [req.body.full_name.trim(), email, whatsapp, phone, existing.rows[0].id,
         contactValidation.email.verified === true, referralName, referralMobile]
      );
      guest = updated.rows[0];
    } else {
      const created = await client.query(
        `INSERT INTO guests(full_name,email,phone,whatsapp_number,country,source,first_enquiry_at,
          last_contact_at,guest_status,email_verified_at,whatsapp_verified_at,referral_name,referral_mobile)
         VALUES($1::varchar,$2::varchar,$3::varchar,$4::varchar,
           CASE WHEN $4::varchar LIKE '+91%' THEN 'India' ELSE 'International' END,
           'WEBSITE',NOW(),NOW(),'ACTIVE',CASE WHEN $5::boolean THEN NOW() ELSE NULL END,NOW(),$6::varchar,$7::varchar)
         RETURNING *`,
        [req.body.full_name.trim(), email, phone, whatsapp,
         contactValidation.email.verified === true, referralName, referralMobile]
      );
      guest = created.rows[0];
    }

    const documentPath = path.relative(path.resolve(__dirname, '..'), req.file.path).replace(/\\/g, '/');
    const enquiry = await client.query(
      `INSERT INTO enquiries(guest_id,property_id,source,check_in,check_out,adults,children,infants,pets,
          guest_message,quoted_amount,quoted_base_amount,extra_guest_amount,quoted_total_amount,status,
          document_type,document_path,document_original_name,document_mime_type,document_verification_status,
          original_amount,discount_percentage,discount_amount,mobile_discount_offer_id,
          taxable_amount,gst_rate,cgst_amount,sgst_amount,igst_amount,gst_amount,currency,price_includes_gst)
       VALUES($1::bigint,$2::bigint,$18::varchar,$3::date,$4::date,$5::integer,$6::integer,$7::integer,$8::integer,$9::text,$10::numeric,$11::numeric,$12::numeric,$13::numeric,'NEW',$14::varchar,$15::text,$16::text,$17::varchar,'PENDING',$19::numeric,$20::numeric,$21::numeric,$22::bigint,$23::numeric,$24::numeric,$25::numeric,$26::numeric,$27::numeric,$28::numeric,$29::varchar,$30::boolean)
       RETURNING *`,
      [guest.id, req.body.property_id, req.body.check_in, req.body.check_out, stay.adults, stay.children,
       stay.infants, stay.pets, req.body.guest_message || null, pricing.quote.total_amount,
       pricing.quote.base_amount, pricing.quote.extra_guest_amount, pricing.quote.total_amount,
       documentType, documentPath, req.file.originalname, req.file.mimetype, applicationSource,
       pricing.quote.original_amount, pricing.quote.discount_percentage, pricing.quote.discount_amount,
        pricing.quote.mobile_discount_offer_id, pricing.quote.taxable_amount, pricing.quote.gst_rate,
        pricing.quote.cgst_amount, pricing.quote.sgst_amount, pricing.quote.igst_amount,
        pricing.quote.gst_amount, pricing.quote.currency, pricing.quote.price_includes_gst]
    );
    await client.query('COMMIT');
    completed = true;
    setImmediate(() => notifyApplicationSubmitted({ application: enquiry.rows[0], guest, property: pricing.property }));
    res.status(201).json({
      success: true,
      message: 'Application submitted; identity document is pending review',
      application: enquiry.rows[0],
      quote: pricing.quote
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Application submission failed:', error);
    const status = error instanceof ContactValidationError ? error.status : 500;
    res.status(status).json({ success: false, message: status === 503 ? error.message : 'Unable to submit application', ...(status === 500 ? { error: error.message } : {}) });
  } finally {
    client.release();
    if (!completed && req.file?.path) fs.unlink(req.file.path, () => {});
  }
};

const uploadEnquiryIdentityDocument = async (req, res) => {
  let decoded;
  try {
    const header = req.headers.authorization || '';
    decoded = jwt.verify(header.startsWith('Bearer ') ? header.slice(7) : '', process.env.JWT_SECRET);
  } catch (_error) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    return res.status(401).json({ success: false, message: 'Invalid or expired upload token' });
  }
  if (decoded.purpose !== 'IDENTITY_DOCUMENT_UPLOAD' || String(decoded.enquiry_id) !== String(req.params.id)) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    return res.status(403).json({ success: false, message: 'Upload token does not authorize this enquiry' });
  }
  const submitted = String(req.body.document_type || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  const documentType = DOCUMENT_TYPE_ALIASES[submitted] || submitted;
  if (!req.file || !DOCUMENT_TYPES.includes(documentType)) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ success: false, message: 'A valid identity document and document_type are required' });
  }
  try {
    const documentPath = path.relative(path.resolve(__dirname, '..'), req.file.path).replace(/\\/g, '/');
    const result = await pool.query(`UPDATE enquiries SET document_type=$1, document_path=$2,
      document_original_name=$3, document_mime_type=$4, document_verification_status='PENDING', updated_at=NOW()
      WHERE id=$5 AND guest_id=$6 AND document_path IS NULL RETURNING id,status,document_verification_status`,
      [documentType, documentPath, req.file.originalname, req.file.mimetype, req.params.id, decoded.guest_id]);
    if (!result.rows.length) {
      fs.unlink(req.file.path, () => {});
      return res.status(409).json({ success: false, message: 'Document already uploaded or enquiry not found' });
    }
    return res.json({ success: true, message: 'Identity document uploaded for staff review', enquiry: result.rows[0] });
  } catch (error) {
    fs.unlink(req.file.path, () => {});
    return res.status(500).json({ success: false, message: 'Unable to upload identity document' });
  }
};

module.exports = {
  listPublicProperties,
  getUnavailableDates,
  getQuote,
  requestVerification,
  confirmVerification,
  submitApplication,
  uploadEnquiryIdentityDocument,
  getPropertyAndQuote,
  getActiveMobileDiscount,
  validateStay
};
