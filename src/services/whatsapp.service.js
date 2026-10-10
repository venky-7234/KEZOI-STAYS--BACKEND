const crypto = require('crypto');

const AUTOMATION_EVENTS = Object.freeze([
  'BOOKING_REQUEST_RECEIVED',
  'BOOKING_APPROVED',
  'BOOKING_REJECTED',
  'PAYMENT_LINK_CREATED',
  'PAYMENT_SUCCESS',
  'PAYMENT_FAILED',
  'BOOKING_CONFIRMED',
  'CHECKIN_REMINDER',
  'CHECKOUT_REMINDER',
  'TEST_MESSAGE'
]);

const normalizeWhatsAppPhone = value => {
  if (value == null) return null;

  const original = String(value).trim();
  const digits = original.replace(/\D/g, '');

  if (!digits) return null;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (original.startsWith('+')) return `+${digits}`;

  return `+${digits}`;
};

const removeUndefinedValues = payload => Object.fromEntries(
  Object.entries(payload).filter(([, value]) => value !== undefined && value !== null)
);

const sendWhatsAppAutomation = async ({
  event,
  phone,
  name,
  bookingReference,
  propertyId,
  propertyName,
  checkIn,
  checkOut,
  guestsCount,
  amount,
  paymentLink,
  paymentStatus,
  status,
  message,
  rejectionReason
}) => {
  if (!AUTOMATION_EVENTS.includes(event)) {
    throw new Error(`Unsupported WhatsApp automation event: ${event}`);
  }

  if (!process.env.N8N_WHATSAPP_WEBHOOK_URL) {
    throw new Error('N8N_WHATSAPP_WEBHOOK_URL is not configured');
  }

  if (!process.env.N8N_WEBHOOK_SIGNING_SECRET) {
    throw new Error('N8N_WEBHOOK_SIGNING_SECRET is not configured');
  }
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const deliveryId = crypto.randomUUID();
  const body = JSON.stringify(removeUndefinedValues({
    eventVersion: '1.0', eventId: deliveryId, occurredAt: new Date().toISOString(),
    event, phone: normalizeWhatsAppPhone(phone), name, bookingReference,
    propertyId, propertyName, checkIn, checkOut, guestsCount, amount,
    paymentLink, paymentStatus, status, message, rejectionReason
  }));
  const signature = crypto.createHmac('sha256', process.env.N8N_WEBHOOK_SIGNING_SECRET)
    .update(`${timestamp}.${body}`).digest('hex');
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(process.env.N8N_WHATSAPP_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-kezoi-timestamp': timestamp,
          'x-kezoi-delivery-id': deliveryId,
          'x-kezoi-signature': `sha256=${signature}`
        },
        body,
        signal: AbortSignal.timeout(10000)
      });
      const responseText = await response.text();
      let responseData = responseText;
      if (responseText) {
        try { responseData = JSON.parse(responseText); } catch (_error) {}
      }
      if (response.ok) return { success: true, status: response.status, data: responseData, deliveryId };
      const error = new Error(`n8n returned HTTP ${response.status}`);
      error.webhookStatus = response.status;
      error.webhookResponse = responseData;
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (error.webhookStatus && error.webhookStatus !== 429 && error.webhookStatus < 500) throw error;
    }
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 250 * (2 ** (attempt - 1))));
  }
  throw lastError;
};

const triggerWhatsAppAutomation = payload => {
  setImmediate(() => {
    sendWhatsAppAutomation(payload).catch(error => {
      console.error('n8n WhatsApp webhook failed:', error.message);
    });
  });
};

const triggerBookingWhatsAppAutomation = ({ event, bookingId, ...extra }) => {
  setImmediate(async () => {
    try {
      const pool = require('../config/database');
      const result = await pool.query(
        `SELECT b.booking_reference, b.check_in, b.check_out, b.adults, b.children,
                b.total_amount, b.payment_status, b.booking_status,
                g.full_name, g.phone, g.whatsapp_number,
                p.id AS property_id, p.property_code, p.property_name
           FROM bookings b
           JOIN guests g ON g.id = b.guest_id
           JOIN properties p ON p.id = b.property_id
          WHERE b.id = $1`,
        [bookingId]
      );

      if (!result.rows.length) return;
      const row = result.rows[0];
      await sendWhatsAppAutomation({
        event,
        phone: row.whatsapp_number || row.phone,
        name: row.full_name,
        bookingReference: row.booking_reference,
        propertyId: row.property_code || row.property_id,
        propertyName: row.property_name,
        checkIn: row.check_in,
        checkOut: row.check_out,
        guestsCount: Number(row.adults || 0) + Number(row.children || 0),
        amount: row.total_amount,
        paymentStatus: row.payment_status,
        status: row.booking_status,
        ...extra
      });
    } catch (error) {
      console.error('n8n WhatsApp webhook failed:', error.message);
    }
  });
};

const triggerEnquiryWhatsAppAutomation = ({ event, enquiryId, ...extra }) => {
  setImmediate(async () => {
    try {
      const pool = require('../config/database');
      const result = await pool.query(
        `SELECT e.id, e.check_in, e.check_out, e.adults, e.children, e.infants,
                e.quoted_total_amount, e.quoted_amount, e.status,
                g.full_name, g.phone, g.whatsapp_number,
                p.id AS property_id, p.property_code, p.property_name
           FROM enquiries e
           JOIN guests g ON g.id = e.guest_id
           LEFT JOIN properties p ON p.id = e.property_id
          WHERE e.id = $1`,
        [enquiryId]
      );

      if (!result.rows.length) return;
      const row = result.rows[0];
      await sendWhatsAppAutomation({
        event,
        phone: row.whatsapp_number || row.phone,
        name: row.full_name,
        bookingReference: `APP-${row.id}`,
        propertyId: row.property_code || row.property_id,
        propertyName: row.property_name,
        checkIn: row.check_in,
        checkOut: row.check_out,
        guestsCount: Number(row.adults || 0) + Number(row.children || 0) + Number(row.infants || 0),
        amount: row.quoted_total_amount || row.quoted_amount,
        status: row.status,
        ...extra
      });
    } catch (error) {
      console.error('n8n WhatsApp webhook failed:', error.message);
    }
  });
};

module.exports = {
  AUTOMATION_EVENTS,
  normalizeWhatsAppPhone,
  sendWhatsAppAutomation,
  triggerWhatsAppAutomation,
  triggerBookingWhatsAppAutomation,
  triggerEnquiryWhatsAppAutomation
};
