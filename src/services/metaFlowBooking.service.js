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
const errorResponse = (screen, message, extraData = {}) => ({
  screen,
  data: {
    ...screenResponse(screen, extraData).data,
    has_error: true,
    error_message: message
  }
});
const SCREEN_DATA_FIELDS = Object.freeze({
  [SCREENS.VIEW_ENTRY]: ['property_id', 'property_code', 'entry_intent', 'has_error', 'error_message'],
  [SCREENS.RESERVE_ENTRY]: ['property_id', 'property_code', 'entry_intent', 'has_error', 'error_message'],
  [SCREENS.START]: ['has_error', 'error_message'],
  [SCREENS.PROPERTIES]: ['check_in', 'check_out', 'adults', 'children', 'infants', 'pets', 'properties', 'no_properties_available', 'has_available_properties', 'search_summary_text', 'quote_generated_at', 'has_error', 'error_message'],
  [SCREENS.DETAILS]: ['property_id', 'property_name', 'property_specs_text', 'property_description', 'property_location', 'amenities', 'amenities_text', 'max_guests', 'max_guests_text', 'gallery', 'has_gallery', 'check_in', 'check_out', 'adults', 'children', 'infants', 'pets', 'has_error', 'error_message'],
  [SCREENS.CALENDAR]: ['property_id', 'check_in', 'check_out', 'adults', 'children', 'infants', 'pets', 'unavailable_dates', 'calendar_refreshed_at', 'has_error', 'error_message'],
  [SCREENS.GUESTS]: ['property_id', 'check_in', 'check_out', 'max_guests', 'max_guests_text', 'adults', 'children', 'infants', 'pets', 'has_error', 'error_message'],
  [SCREENS.QUOTE]: ['property_id', 'property_name', 'check_in', 'check_out', 'adults', 'children', 'infants', 'pets', 'nights', 'currency', 'base_amount', 'extra_guests', 'extra_guest_amount', 'taxable_amount', 'gst_rate', 'cgst_amount', 'sgst_amount', 'gst_amount', 'total_amount', 'stay_dates_text', 'price_breakdown_text', 'total_amount_text', 'quote_caption_text', 'quote_generated_at', 'has_error', 'error_message'],
  [SCREENS.GUEST_DETAILS]: ['property_id', 'property_name', 'check_in', 'check_out', 'adults', 'children', 'infants', 'pets', 'has_error', 'error_message'],
  [SCREENS.REVIEW]: ['property_id', 'property_name', 'check_in', 'check_out', 'adults', 'children', 'infants', 'pets', 'guest_name', 'guest_email', 'whatsapp_number', 'country_code', 'special_requests', 'has_special_requests', 'stay_details_text', 'guest_contact_text', 'special_requests_text', 'quote_summary_text', 'total_amount_text', 'quote', 'quote_generated_at', 'has_error', 'error_message'],
  [SCREENS.COMPLETE]: ['enquiry_reference', 'enquiry_reference_text', 'enquiry_status', 'payment_status', 'enquiry_status_text', 'continuation_type', 'continuation_url', 'replayed', 'message']
});
const screenResponse = (screen, data) => {
  const allowed = SCREEN_DATA_FIELDS[screen] || [];
  const entries = allowed
    .filter(key => data[key] !== undefined)
    .map(key => [key, data[key]]);
  if (allowed.includes('has_error') && data.has_error === undefined) {
    entries.push(['has_error', false]);
  }
  return { screen, data: Object.fromEntries(entries) };
};
const normalizeStayData = data => {
  const stayDates = data.stay_dates && typeof data.stay_dates === 'object' ? data.stay_dates : {};
  const check_in = stayDates['start-date'] || stayDates.start_date || stayDates['startDate'] || data.check_in;
  const check_out = stayDates['end-date'] || stayDates.end_date || stayDates['endDate'] || data.check_out;
  const guests = data.guests == null ? data.adults : data.guests;
  return {
    ...data,
    ...(check_in ? { check_in: String(check_in).trim() } : {}),
    ...(check_out ? { check_out: String(check_out).trim() } : {}),
    adults: guests == null ? 1 : Number(guests),
    children: data.children == null ? 0 : Number(data.children),
    infants: data.infants == null ? 0 : Number(data.infants),
    pets: data.pets == null ? 0 : Number(data.pets)
  };
};
const counts = data => ({
  adults: data.adults == null ? 1 : Number(data.adults),
  children: Number(data.children || 0),
  infants: Number(data.infants || 0),
  pets: Number(data.pets || 0)
});
const stayInput = data => {
  const normalized = normalizeStayData(data);
  return {
    check_in: normalized.check_in,
    check_out: normalized.check_out,
    ...counts(normalized),
    whatsapp_number: normalized.whatsapp_number,
    phone: normalized.phone,
    mobile_number: normalized.mobile_number,
    country_code: normalized.country_code
  };
};

const formatPropertySpecs = property => {
  const parts = [];
  if (property.bedrooms) parts.push(`${property.bedrooms} ${property.bedrooms === 1 ? 'Bedroom' : 'Bedrooms'}`);
  if (property.bathrooms) parts.push(`${property.bathrooms} ${property.bathrooms === 1 ? 'Bathroom' : 'Bathrooms'}`);
  if (property.property_type) parts.push(property.property_type.charAt(0).toUpperCase() + property.property_type.slice(1).toLowerCase());
  return parts.length ? parts.join(' • ') : 'Verified residence';
};

const formatPropertyCatalogueItem = (p) => {
  const location = p.area || p.city || 'Hyderabad';
  const beds = `${p.bedrooms || 0} bedrooms`;
  const baths = `${p.bathrooms || 0} bathrooms`;
  const maxGuests = Number(p.max_guests || 0);
  const capacity = maxGuests > 0 ? `Up to ${maxGuests} guests` : '';
  const specs = [beds, baths, capacity].filter(Boolean).join(' • ');

  let priceText = '';
  if (p.quote && p.quote.total_amount) {
    priceText = `${p.quote.currency || 'INR'} ${money(p.quote.total_amount)}`;
  } else if (p.base_price != null) {
    priceText = `From ${p.currency || 'INR'} ${money(p.base_price)}/night`;
  }

  const parts = [location, specs, priceText].filter(Boolean);
  return {
    id: String(p.id),
    title: p.property_name,
    description: parts.join(' | ')
  };
};

const formatPropertyDetailsData = (property, data = {}) => {
  const amenities = Array.isArray(property.public_amenities) ? property.public_amenities : [];
  const amenitiesText = amenities.length ? amenities.join(' • ') : 'Verified amenities available upon request';
  const photos = property.photos || [];
  const gallery = photos
    .filter(photo => photo && photo.meta_image_base64 && typeof photo.meta_image_base64 === 'string' && photo.meta_image_base64.trim().length > 0)
    .map(photo => ({
      src: photo.meta_image_base64,
      'alt-text': photo.alt_text || photo.caption || property.property_name
    }));
  const maxGuests = Number(property.max_guests || 0);
  const maxGuestsText = maxGuests > 0 ? `Accommodates up to ${maxGuests} guests` : 'Capacity confirmed upon booking';
  const desc = String(property.public_description || '').trim() ||
    `${property.property_name} is a luxury ${property.bedrooms || ''} bedroom ${property.property_type || 'residence'} situated in ${property.area || property.city || 'Hyderabad'}.`;
  const location = String(property.public_location || '').trim() ||
    [property.area, property.city].filter(Boolean).join(', ') || 'Hyderabad, India';

  return {
    ...data,
    property_id: String(property.id),
    property_name: property.property_name,
    property_specs_text: formatPropertySpecs(property),
    property_description: desc,
    property_location: location,
    amenities,
    amenities_text: amenitiesText,
    max_guests: maxGuests,
    max_guests_text: maxGuestsText,
    gallery,
    has_gallery: gallery.length > 0
  };
};

const listActiveProperties = async (db) => {
  const result = await db.query(
    `SELECT p.id, p.property_code, p.property_name, p.property_type, p.area, p.city,
            p.bedrooms, p.bathrooms, p.max_guests, p.base_price, p.included_guests,
            p.extra_guest_price, p.currency, p.gst_enabled, p.gst_rate, p.price_includes_gst,
            p.public_description, p.public_location, p.public_amenities
       FROM properties p
      WHERE p.status = 'ACTIVE'
      ORDER BY p.property_name`
  );
  return result.rows;
};

const propertyDetails = async (db, propertyId, propertyCode) => {
  let result;
  if (propertyId && !isNaN(Number(propertyId))) {
    result = await db.query(`SELECT id, property_code, property_name, property_type, area, city,
      bedrooms, bathrooms, max_guests, public_description, public_location, public_amenities
      FROM properties WHERE id=$1 AND status='ACTIVE'`, [propertyId]);
    if (result.rows.length && propertyCode && String(result.rows[0].property_code).toLowerCase() !== String(propertyCode).toLowerCase()) {
      return null;
    }
  } else if (propertyCode && typeof propertyCode === 'string' && propertyCode.trim()) {
    result = await db.query(`SELECT id, property_code, property_name, property_type, area, city,
      bedrooms, bathrooms, max_guests, public_description, public_location, public_amenities
      FROM properties WHERE LOWER(property_code)=LOWER($1) AND status='ACTIVE'`, [propertyCode.trim()]);
  } else {
    return null;
  }
  if (!result || !result.rows.length) return null;
  const prop = result.rows[0];
  const photos = await db.query(`SELECT id, alt_text, caption, meta_image_base64, display_order, is_cover
    FROM property_marketing_photos WHERE property_id=$1 AND is_active=TRUE
    ORDER BY is_cover DESC, display_order, id LIMIT 3`, [prop.id]);
  return { ...prop, photos: photos.rows };
};

const unavailableDates = async (db, propertyId) => {
  if (!propertyId || isNaN(Number(propertyId))) return [];
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
  if (data.special_requests && String(data.special_requests).length > 600) {
    return { status: 400, error: 'Special requests cannot exceed 600 characters' };
  }
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
      quoted_amount,quoted_base_amount,extra_guest_amount,quoted_total_amount,status,document_verification_status,original_amount,taxable_amount,
      gst_rate,cgst_amount,sgst_amount,igst_amount,gst_amount,currency,price_includes_gst,integration_idempotency_key,integration_request_hash,
      discount_percentage,discount_amount,mobile_discount_offer_id)
      VALUES($1,$2,'WHATSAPP',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$10,'NEW','PENDING',$13,$14,$15,$16,$17,0,$18,$19,FALSE,$20,$21,$22,$23,$24) RETURNING *`,
      [guest.id, priced.property.id, stay.check_in, stay.check_out, stay.adults, stay.children, stay.infants, stay.pets, data.special_requests || null,
       q.total_amount, q.base_amount, q.extra_guest_amount, q.original_amount, q.taxable_amount, q.gst_rate, q.cgst_amount, q.sgst_amount, q.gst_amount, q.currency, key, hash,
       q.discount_percentage || 0, q.discount_amount || 0, q.mobile_discount_offer_id || null])).rows[0];
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
  const data = normalizeStayData(payload.data || {});
  if (payload.action !== 'INIT' && payload.action !== 'data_exchange') {
    return errorResponse(payload.screen || SCREENS.START, 'Unsupported Flow action', data);
  }
  if (payload.action === 'INIT' || !payload.screen) {
    if (data.entry_intent === 'view_stay') payload.screen = SCREENS.VIEW_ENTRY;
    else if (data.entry_intent === 'reserve') payload.screen = SCREENS.RESERVE_ENTRY;
    else if (payload.action === 'INIT') return errorResponse(SCREENS.START, 'A supported entry intent is required', data);
  }
  if (payload.screen === SCREENS.VIEW_ENTRY) {
    if (data.property_id || data.property_code) {
      const property = await propertyDetails(db, data.property_id, data.property_code);
      if (!property) return errorResponse(SCREENS.VIEW_ENTRY, 'Property not found or inactive', data);
      return screenResponse(SCREENS.DETAILS, formatPropertyDetailsData(property, data));
    }
    const activeProperties = await listActiveProperties(db);
    const hasAvailable = activeProperties.length > 0;
    return screenResponse(SCREENS.PROPERTIES, {
      ...data,
      search_summary_text: 'Explore our handpicked luxury villas and apartments in Hyderabad.',
      properties: activeProperties.map(p => formatPropertyCatalogueItem(p)),
      no_properties_available: !hasAvailable,
      has_available_properties: hasAvailable,
      quote_generated_at: new Date().toISOString()
    });
  }
  if (payload.screen === SCREENS.RESERVE_ENTRY) {
    if (data.property_id || data.property_code) {
      const property = await propertyDetails(db, data.property_id, data.property_code);
      if (!property) return errorResponse(SCREENS.RESERVE_ENTRY, 'Property not found or inactive', data);
      return screenResponse(SCREENS.CALENDAR, { ...data, property_id: String(property.id), unavailable_dates: await unavailableDates(db, property.id), calendar_refreshed_at: new Date().toISOString() });
    }
    return screenResponse(SCREENS.START, { ...data });
  }
  if (payload.screen === SCREENS.START) {
    const guests = data.adults;
    const result = await findAvailableProperties(db, {
      check_in: data.check_in,
      check_out: data.check_out,
      adults: guests,
      children: data.children,
      infants: data.infants,
      pets: data.pets,
      whatsapp_number: data.whatsapp_number,
      phone: data.phone,
      mobile_number: data.mobile_number,
      country_code: data.country_code
    });
    if (result.error) return errorResponse(SCREENS.START, result.error, data);
    const hasAvailable = result.properties.length > 0;
    return screenResponse(SCREENS.PROPERTIES, {
      ...data,
      check_in: result.stay.check_in,
      check_out: result.stay.check_out,
      adults: guests,
      children: data.children,
      infants: data.infants,
      pets: data.pets,
      search_summary_text: `Live results for ${result.stay.check_in} to ${result.stay.check_out} (${result.stay.nights} night${result.stay.nights === 1 ? '' : 's'}).`,
      properties: result.properties.map(p => formatPropertyCatalogueItem(p)),
      no_properties_available: !hasAvailable,
      has_available_properties: hasAvailable,
      quote_generated_at: new Date().toISOString()
    });
  }
  if (payload.screen === SCREENS.PROPERTIES) {
    const property = await propertyDetails(db, data.property_id, data.property_code);
    if (!property) return errorResponse(SCREENS.PROPERTIES, 'Property not found or inactive', data);
    return screenResponse(SCREENS.DETAILS, formatPropertyDetailsData(property, data));
  }
  if (payload.screen === SCREENS.DETAILS) return screenResponse(SCREENS.CALENDAR, { ...data, unavailable_dates: await unavailableDates(db, data.property_id), calendar_refreshed_at: new Date().toISOString() });
  if (payload.screen === SCREENS.CALENDAR) {
    const parsed = parseStay(stayInput({ ...data, adults: data.adults == null ? 1 : data.adults }));
    const blocked = await unavailableDates(db, data.property_id);
    if (parsed.error) return errorResponse(SCREENS.CALENDAR, parsed.error, { ...data, unavailable_dates: blocked });
    const selected = new Set(); for (let day = new Date(`${parsed.check_in}T00:00:00Z`), end = new Date(`${parsed.check_out}T00:00:00Z`); day < end; day = new Date(day.getTime() + 86400000)) selected.add(day.toISOString().slice(0, 10));
    if (blocked.some(date => selected.has(date))) return errorResponse(SCREENS.CALENDAR, 'One or more selected dates are no longer available', { ...data, unavailable_dates: blocked });
    const property = await propertyDetails(db, data.property_id, data.property_code);
    if (!property) return errorResponse(SCREENS.CALENDAR, 'Property not found or inactive', { ...data, unavailable_dates: blocked });
    const maxGuestsNum = Number(property?.max_guests || 0);
    const maxGuestsText = maxGuestsNum > 0 ? `This property accommodates up to ${maxGuestsNum} guests.` : 'Guest capacity confirmed upon booking.';
    return screenResponse(SCREENS.GUESTS, { ...data, check_in: parsed.check_in, check_out: parsed.check_out, max_guests: maxGuestsNum, max_guests_text: maxGuestsText });
  }
  if (payload.screen === SCREENS.GUESTS) {
    const priced = await selectedQuote(db, data);
    if (priced.error) {
      const prop = await propertyDetails(db, data.property_id, data.property_code);
      const maxGuestsNum = Number(prop?.max_guests || data.max_guests || 0);
      const maxGuestsText = maxGuestsNum > 0 ? `This property accommodates up to ${maxGuestsNum} guests.` : 'Guest capacity confirmed upon booking.';
      return errorResponse(SCREENS.GUESTS, priced.error, { ...data, max_guests: maxGuestsNum, max_guests_text: maxGuestsText });
    }
    const q = priced.property.quote;
    const nights = q.nights;
    const currency = q.currency;
    const baseAmount = money(q.base_amount);
    const extraGuestAmount = money(q.extra_guest_amount);
    const taxableAmount = money(q.taxable_amount);
    const gstRate = q.gst_rate;
    const cgstAmount = money(q.cgst_amount);
    const sgstAmount = money(q.sgst_amount);
    const gstAmount = money(q.gst_amount);
    const totalAmount = money(q.total_amount);
    const nowIso = new Date().toISOString();
    const stayDatesText = `Dates: ${priced.stay.check_in} to ${priced.stay.check_out} • ${nights} nights`;
    const discountLine = q.discount_amount > 0 ? `\nDiscount (${q.discount_percentage}%): -${currency} ${money(q.discount_amount)}` : '';
    const priceBreakdownText = `Stay (${nights} nights): ${currency} ${baseAmount}\nExtra guest charges: ${currency} ${extraGuestAmount}${discountLine}\nTaxable amount: ${currency} ${taxableAmount}\nGST (${gstRate}%): ${currency} ${gstAmount}\n  • CGST: ${currency} ${cgstAmount}\n  • SGST: ${currency} ${sgstAmount}`;
    const totalAmountText = `Total: ${currency} ${totalAmount}`;
    const quoteCaptionText = `Live quote calculated on ${nowIso}. Availability and prices are verified again before enquiry creation.`;
    return screenResponse(SCREENS.QUOTE, {
      ...data,
      property_name: priced.property.property_name,
      check_in: priced.stay.check_in,
      check_out: priced.stay.check_out,
      nights,
      currency,
      base_amount: baseAmount,
      extra_guests: q.extra_guests,
      extra_guest_amount: extraGuestAmount,
      taxable_amount: taxableAmount,
      gst_rate: gstRate,
      cgst_amount: cgstAmount,
      sgst_amount: sgstAmount,
      gst_amount: gstAmount,
      total_amount: totalAmount,
      stay_dates_text: stayDatesText,
      price_breakdown_text: priceBreakdownText,
      total_amount_text: totalAmountText,
      quote_caption_text: quoteCaptionText,
      quote_generated_at: nowIso,
      has_error: false
    });
  }
  if (payload.screen === SCREENS.QUOTE) return screenResponse(SCREENS.GUEST_DETAILS, data);
  if (payload.screen === SCREENS.GUEST_DETAILS) {
    const priced = await selectedQuote(db, data); if (priced.error) return errorResponse(SCREENS.GUEST_DETAILS, priced.error, data);
    const phone = validatePhoneNumber(data.whatsapp_number, data.country_code || 'IN');
    if (!String(data.guest_name || '').trim()) return errorResponse(SCREENS.GUEST_DETAILS, 'Guest name is required', data);
    if (!phone.valid || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.guest_email || '').trim())) return errorResponse(SCREENS.GUEST_DETAILS, 'Enter a valid email address and WhatsApp number', data);
    if (data.special_requests && String(data.special_requests).length > 600) return errorResponse(SCREENS.GUEST_DETAILS, 'Special requests cannot exceed 600 characters', data);
    const hasSpecialRequests = Boolean(String(data.special_requests || '').trim());
    const q = priced.property.quote;
    const nowIso = new Date().toISOString();
    const stayDetailsText = `Dates: ${priced.stay.check_in} to ${priced.stay.check_out}\nAdults: ${data.adults} • Children: ${data.children || 0} • Infants: ${data.infants || 0} • Pets: ${data.pets || 0}`;
    const guestContactText = `Name: ${String(data.guest_name).trim()}\nEmail: ${String(data.guest_email).trim()}\nWhatsApp: ${phone.normalizedNumber}\nCountry code: ${data.country_code || 'IN'}`;
    const specialRequestsText = `Special requests: ${String(data.special_requests || '').trim()}`;
    const discountLine = q.discount_amount > 0 ? `\nDiscount (${q.discount_percentage}%): -${q.currency} ${money(q.discount_amount)}` : '';
    const quoteSummaryText = `Stay (${q.nights} nights): ${q.currency} ${money(q.base_amount)}\nExtra guests: ${q.currency} ${money(q.extra_guest_amount)}${discountLine}\nTaxable amount: ${q.currency} ${money(q.taxable_amount)}\nGST (${q.gst_rate}%): ${q.currency} ${money(q.gst_amount)} (CGST: ${q.currency} ${money(q.cgst_amount)} + SGST: ${q.currency} ${money(q.sgst_amount)})`;
    const totalAmountText = `Total: ${q.currency} ${money(q.total_amount)}`;
    return screenResponse(SCREENS.REVIEW, {
      ...data,
      check_in: priced.stay.check_in,
      check_out: priced.stay.check_out,
      whatsapp_number: phone.normalizedNumber,
      property_name: priced.property.property_name,
      quote: priced.property.quote,
      stay_details_text: stayDetailsText,
      guest_contact_text: guestContactText,
      special_requests_text: specialRequestsText,
      quote_summary_text: quoteSummaryText,
      total_amount_text: totalAmountText,
      has_special_requests: hasSpecialRequests,
      has_error: false,
      quote_generated_at: nowIso
    });
  }
  if (payload.screen === SCREENS.REVIEW) {
    const result = await createPendingEnquiry(db, { ...data, flow_token: payload.flow_token || data.flow_token }); if (result.error) return errorResponse(SCREENS.REVIEW, result.error, data);
    const ref = `APP-${result.enquiry.id}`;
    return screenResponse(SCREENS.COMPLETE, {
      enquiry_reference: ref,
      enquiry_reference_text: `Enquiry ${ref}`,
      enquiry_status: result.enquiry.status,
      payment_status: 'NOT_STARTED',
      enquiry_status_text: `Enquiry status: ${result.enquiry.status}\nPayment status: NOT_STARTED`,
      continuation_type: 'IDENTITY_DOCUMENT_UPLOAD',
      continuation_url: continuation(result.enquiry),
      replayed: result.replayed,
      message: 'Enquiry created. No booking or payment has been confirmed.'
    });
  }
  return errorResponse(payload.screen || SCREENS.START, 'Unsupported Flow screen', data);
};

module.exports = { SCREENS, handleFlowAction, propertyDetails, listActiveProperties, formatPropertyCatalogueItem, unavailableDates, selectedQuote, createPendingEnquiry, enquiryKey };
