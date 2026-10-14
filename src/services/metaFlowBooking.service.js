const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { parseStay, findAvailableProperties, ACTIVE_BOOKING_STATUSES } = require('./availability.service');
const { validatePhoneNumber, INVALID_MOBILE_MESSAGE } = require('../utils/phoneValidator');

const SCREENS = Object.freeze({
  VIEW_ENTRY: 'VIEW_STAY_ENTRY', RESERVE_ENTRY: 'RESERVE_ENTRY',
  START: 'BOOKING_DETAILS', PROPERTIES: 'PROPERTY_SELECTION', DETAILS: 'PROPERTY_DETAILS',
  CALENDAR: 'CALENDAR', GUESTS: 'GUEST_SELECTION', QUOTE: 'LIVE_QUOTE',
  GUEST_DETAILS: 'GUEST_DETAILS', REVIEW: 'BOOKING_REVIEW', COMPLETE: 'ENQUIRY_CREATED'
});

const asDate = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
const money = value => Number(Number(value || 0).toFixed(2));
const errorResponse = (screen, message) => ({ screen, data: { error_message: message } });
const counts = data => ({ adults: data.adults, children: data.children ?? 0, infants: data.infants ?? 0, pets: data.pets ?? 0 });
const stayInput = data => ({ check_in: data.check_in, check_out: data.check_out, ...counts(data) });

const propertyDetails = async (db, propertyId) => {
  const result = await db.query(`SELECT id, property_code, property_name, property_type, area, city,
    bedrooms, bathrooms, max_guests, public_description, public_location, public_amenities
    FROM properties WHERE id=$1 AND status='ACTIVE'`, [propertyId]);
  if (!result.rows.length) return null;
  const photos = await db.query(`SELECT id, alt_text, caption, meta_image_base64, display_order, is_cover
    FROM property_marketing_photos WHERE property_id=$1 AND is_active=TRUE
    ORDER BY is_cover DESC, display_order, id LIMIT 3`, [propertyId]);
  return { ...result.rows[0], photos: photos.rows };
};

const unavailableDates = async (db, propertyId) => {
  const result = await db.query(`SELECT start_date, end_date FROM (
    SELECT check_in AS start_date, check_out AS end_date FROM bookings
      WHERE property_id=$1 AND booking_status=ANY($2::text[]) AND check_out>=CURRENT_DATE
    UNION ALL SELECT start_date, end_date FROM property_blocks
      WHERE property_id=$1 AND end_date>=CURRENT_DATE) dates ORDER BY start_date`, [propertyId, ACTIVE_BOOKING_STATUSES]);
  const dates = new Set();
  for (const range of result.rows) {
    for (let day = new Date(`${asDate(range.start_date)}T00:00:00Z`), end = new Date(`${asDate(range.end_date)}T00:00:00Z`); day < end; day = new Date(day.getTime() + 86400000)) dates.add(day.toISOString().slice(0, 10));
  }
  return [...dates].sort();
};

const selectedQuote = async (db, data) => {
  const result = await findAvailableProperties(db, stayInput(data));
  if (result.error) return result;
  const property = result.properties.find(item => String(item.id) === String(data.property_id));
  return property ? { stay: result.stay, property } : { status: 409, error: 'Property is unavailable or cannot accommodate these guests' };
};

const enquiryKey = data => {
  const token = String(data.flow_token || '').trim();
  if (!token) return null;
  return `meta-flow:${crypto.createHash('sha256').update(token).digest('hex')}`;
};

const submissionHash = (data, email, phone) => crypto.createHash('sha256').update(JSON.stringify({
  property_id: String(data.property_id),
  check_in: data.check_in,
  check_out: data.check_out,
  adults: Number(data.adults),
  children: Number(data.children || 0),
  infants: Number(data.infants || 0),
  pets: Number(data.pets || 0),
  guest_name: String(data.guest_name).trim(),
  guest_email: email,
  whatsapp_number: phone,
  special_requests: String(data.special_requests || '').trim()
})).digest('hex');

const validateContinuationConfiguration = () => {
  if (!String(process.env.JWT_SECRET || '').trim()) return 'Secure continuation is not configured';
  if (!String(process.env.WEBSITE_APPLICATION_URL || '').trim()) return 'Secure identity-upload page is not configured';
  try {
    const url = new URL(process.env.WEBSITE_APPLICATION_URL);
    if (url.protocol !== 'https:') return 'Secure continuation URL must use HTTPS';
  } catch (_error) {
    return 'Secure continuation URL is invalid';
  }
  return null;
};

const createPendingEnquiry = async (db, data) => {
  const required = ['property_id', 'check_in', 'check_out', 'guest_name', 'guest_email', 'whatsapp_number'];
  const missing = required.filter(field => !String(data[field] || '').trim());
  if (missing.length) return { status: 400, error: `Missing required fields: ${missing.join(', ')}` };
  const email = String(data.guest_email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 400, error: 'A valid email is required' };
  const phone = validatePhoneNumber(data.whatsapp_number, data.country_code || 'IN');
  if (!phone.valid) return { status: 400, error: INVALID_MOBILE_MESSAGE };
  const key = enquiryKey(data);
  if (!key) return { status: 400, error: 'A Flow submission token is required' };
  const continuationError = validateContinuationConfiguration();
  if (continuationError) return { status: 503, error: continuationError };
  const hash = submissionHash(data, email, phone.normalizedNumber);
  await db.query('BEGIN');
  try {
    const prior = await db.query('SELECT e.* FROM enquiries e WHERE e.integration_idempotency_key=$1 FOR UPDATE', [key]);
    if (prior.rows.length) {
      if (prior.rows[0].integration_request_hash !== hash) throw Object.assign(new Error('This Flow submission token was already used for different booking details'), { status: 409 });
      await db.query('COMMIT');
      return { enquiry: prior.rows[0], replayed: true };
    }
    await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [data.property_id]);
    const priced = await selectedQuote(db, data);
    if (priced.error) throw Object.assign(new Error(priced.error), { status: priced.status || 409 });
    let guest = (await db.query('SELECT * FROM guests WHERE LOWER(email)=$1 OR whatsapp_number=$2 ORDER BY id LIMIT 1', [email, phone.normalizedNumber])).rows[0];
    if (!guest) guest = (await db.query(`INSERT INTO guests(full_name,email,phone,whatsapp_number,country,source,first_enquiry_at,last_contact_at,guest_status)
      VALUES($1,$2,$3,$3,CASE WHEN $3 LIKE '+91%' THEN 'India' ELSE 'International' END,'WHATSAPP',NOW(),NOW(),'ACTIVE') RETURNING *`, [String(data.guest_name).trim(), email, phone.normalizedNumber])).rows[0];
    const q = priced.property.quote; const stay = priced.stay;
    const enquiry = (await db.query(`INSERT INTO enquiries(guest_id,property_id,source,check_in,check_out,adults,children,infants,pets,guest_message,
      quoted_amount,quoted_base_amount,extra_guest_amount,quoted_total_amount,status,document_verification_status,original_amount,discount_percentage,
      discount_amount,taxable_amount,gst_rate,cgst_amount,sgst_amount,igst_amount,gst_amount,currency,price_includes_gst,integration_idempotency_key,integration_request_hash)
      VALUES($1,$2,'WHATSAPP',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$10,'NEW','PENDING',$13,0,0,$14,$15,$16,$17,0,$18,$19,FALSE,$20,$21) RETURNING *`,
      [guest.id, priced.property.id, stay.check_in, stay.check_out, stay.adults, stay.children, stay.infants, stay.pets, data.special_requests || null,
       q.total_amount, q.base_amount, q.extra_guest_amount, q.original_amount, q.taxable_amount, q.gst_rate, q.cgst_amount, q.sgst_amount, q.gst_amount, q.currency, key, hash])).rows[0];
    await db.query('COMMIT');
    return { enquiry, replayed: false };
  } catch (error) { await db.query('ROLLBACK'); return { status: error.status || 500, error: error.message || 'Unable to create enquiry' }; }
};

const continuation = enquiry => {
  const base = process.env.WEBSITE_APPLICATION_URL;
  const token = jwt.sign({ purpose: 'IDENTITY_DOCUMENT_UPLOAD', enquiry_id: enquiry.id, guest_id: enquiry.guest_id }, process.env.JWT_SECRET, { expiresIn: '24h' });
  return `${base}${base.includes('?') ? '&' : '?'}enquiry=${enquiry.id}&upload_token=${encodeURIComponent(token)}`;
};

const handleFlowAction = async (db, payload) => {
  if (payload.action === 'ping') return { data: { status: 'active' } };
  const data = { ...(payload.data || {}), flow_token: payload.flow_token || payload.data?.flow_token };
  if (payload.action === 'INIT') {
    if (data.entry_intent === 'view_stay') payload.screen = SCREENS.VIEW_ENTRY;
    else if (data.entry_intent === 'reserve') payload.screen = SCREENS.RESERVE_ENTRY;
    else return errorResponse(SCREENS.START, 'A supported entry intent is required');
  } else if (payload.action !== 'data_exchange') return errorResponse(payload.screen || SCREENS.START, 'Unsupported Flow action');
  if (payload.screen === SCREENS.VIEW_ENTRY) {
    const property = await propertyDetails(db, data.property_id);
    if (!property) return errorResponse(SCREENS.VIEW_ENTRY, 'Property not found or inactive');
    const amenities = property.public_amenities || [];
    return { screen: SCREENS.DETAILS, data: { ...data, property_id: String(property.id), property_name: property.property_name, property_description: property.public_description || '', property_location: property.public_location || [property.area, property.city].filter(Boolean).join(', '), amenities, amenities_text: amenities.join(' • '), max_guests: Number(property.max_guests || 0), gallery: property.photos.map(photo => ({ src: photo.meta_image_base64, 'alt-text': photo.alt_text })) } };
  }
  if (payload.screen === SCREENS.RESERVE_ENTRY) {
    const property = await propertyDetails(db, data.property_id);
    if (!property) return errorResponse(SCREENS.RESERVE_ENTRY, 'Property not found or inactive');
    return { screen: SCREENS.CALENDAR, data: { ...data, property_id: String(property.id), property_name: property.property_name, unavailable_dates: await unavailableDates(db, property.id), calendar_refreshed_at: new Date().toISOString() } };
  }
  if (payload.screen === SCREENS.START) {
    const guests = data.guests == null ? data.adults : data.guests;
    const result = await findAvailableProperties(db, { check_in: data.check_in, check_out: data.check_out, adults: guests, children: data.children ?? 0, infants: data.infants ?? 0, pets: data.pets ?? 0 });
    if (result.error) return errorResponse(SCREENS.START, result.error);
    return { screen: SCREENS.PROPERTIES, data: { ...data, adults: String(guests), properties: result.properties.map(p => ({ id: String(p.id), title: p.property_name, description: `${p.bedrooms || 0} bedrooms | ${p.bathrooms || 0} bathrooms | ${p.quote.currency} ${p.quote.total_amount}` })), no_properties_available: !result.properties.length, quote_generated_at: new Date().toISOString() } };
  }
  if (payload.screen === SCREENS.PROPERTIES) {
    const property = await propertyDetails(db, data.property_id);
    if (!property) return errorResponse(SCREENS.PROPERTIES, 'Property not found or inactive');
    const amenities = property.public_amenities || [];
    return { screen: SCREENS.DETAILS, data: { ...data, property_id: String(property.id), property_name: property.property_name, property_description: property.public_description || '', property_location: property.public_location || [property.area, property.city].filter(Boolean).join(', '), amenities, amenities_text: amenities.join(' • '), max_guests: Number(property.max_guests || 0), gallery: property.photos.map(photo => ({ src: photo.meta_image_base64, 'alt-text': photo.alt_text })) } };
  }
  if (payload.screen === SCREENS.DETAILS) return { screen: SCREENS.CALENDAR, data: { ...data, unavailable_dates: await unavailableDates(db, data.property_id), calendar_refreshed_at: new Date().toISOString() } };
  if (payload.screen === SCREENS.CALENDAR) {
    const parsed = parseStay(stayInput({ ...data, adults: data.adults || 1 }));
    if (parsed.error) return errorResponse(SCREENS.CALENDAR, parsed.error);
    const blocked = await unavailableDates(db, data.property_id);
    const selected = new Set(); for (let day = new Date(`${data.check_in}T00:00:00Z`), end = new Date(`${data.check_out}T00:00:00Z`); day < end; day = new Date(day.getTime() + 86400000)) selected.add(day.toISOString().slice(0, 10));
    if (blocked.some(date => selected.has(date))) return errorResponse(SCREENS.CALENDAR, 'One or more selected dates are no longer available');
    const property = await propertyDetails(db, data.property_id);
    if (!property) return errorResponse(SCREENS.CALENDAR, 'Property not found or inactive');
    return { screen: SCREENS.GUESTS, data: { ...data, max_guests: Number(property?.max_guests || 0) } };
  }
  if (payload.screen === SCREENS.GUESTS) {
    const priced = await selectedQuote(db, data); if (priced.error) return errorResponse(SCREENS.GUESTS, priced.error);
    const q = priced.property.quote;
    return { screen: SCREENS.QUOTE, data: { ...data, property_name: priced.property.property_name, nights: q.nights, currency: q.currency, base_amount: money(q.base_amount), extra_guests: q.extra_guests, extra_guest_amount: money(q.extra_guest_amount), taxable_amount: money(q.taxable_amount), gst_rate: q.gst_rate, cgst_amount: money(q.cgst_amount), sgst_amount: money(q.sgst_amount), gst_amount: money(q.gst_amount), total_amount: money(q.total_amount), quote_generated_at: new Date().toISOString() } };
  }
  if (payload.screen === SCREENS.QUOTE) return { screen: SCREENS.GUEST_DETAILS, data };
  if (payload.screen === SCREENS.GUEST_DETAILS) {
    const priced = await selectedQuote(db, data); if (priced.error) return errorResponse(SCREENS.GUEST_DETAILS, priced.error);
    const phone = validatePhoneNumber(data.whatsapp_number, data.country_code || 'IN');
    if (!String(data.guest_name || '').trim()) return errorResponse(SCREENS.GUEST_DETAILS, 'Guest name is required');
    if (!phone.valid || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.guest_email || '').trim())) return errorResponse(SCREENS.GUEST_DETAILS, 'Enter a valid email address and WhatsApp number');
    return { screen: SCREENS.REVIEW, data: { ...data, whatsapp_number: phone.normalizedNumber, property_name: priced.property.property_name, quote: priced.property.quote, quote_generated_at: new Date().toISOString() } };
  }
  if (payload.screen === SCREENS.REVIEW) {
    const result = await createPendingEnquiry(db, data); if (result.error) return errorResponse(SCREENS.REVIEW, result.error);
    return { screen: SCREENS.COMPLETE, data: { enquiry_reference: `APP-${result.enquiry.id}`, enquiry_status: result.enquiry.status, payment_status: 'NOT_STARTED', continuation_type: 'IDENTITY_DOCUMENT_UPLOAD', continuation_url: continuation(result.enquiry), replayed: result.replayed, message: 'Enquiry created. No booking or payment has been confirmed.' } };
  }
  return errorResponse(payload.screen || SCREENS.START, 'Unsupported Flow screen');
};

module.exports = { SCREENS, handleFlowAction, propertyDetails, unavailableDates, selectedQuote, createPendingEnquiry, enquiryKey };
