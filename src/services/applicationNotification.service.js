const pool = require('../config/database');
const { sendEmail } = require('./mail.service');
const { sendWhatsAppAutomation } = require('./whatsapp.service');

const ADMIN_EMAIL_REPEAT_COUNT = 3;

const notifyApplicationSubmitted = async ({ application, guest, property }) => {
  const adminResult = await pool.query(`
    SELECT DISTINCT email
    FROM users
    WHERE role IN ('SUPER_ADMIN', 'ADMIN')
      AND NULLIF(TRIM(email), '') IS NOT NULL
  `);
  const guestEmail = sendEmail({
    to: guest.email,
    subject: `Application received #${application.id}`,
    text: `Hi ${guest.full_name}, we received your application for ${property.property_name}. Your reference is #${application.id}. Our team will review it and contact you shortly.`
  });
  const adminEmails = adminResult.rows.flatMap(admin =>
    Array.from({ length: ADMIN_EMAIL_REPEAT_COUNT }, () => sendEmail({
      to: admin.email,
      subject: `New ${application.source} application #${application.id}`,
      text: `${guest.full_name} submitted an application for ${property.property_name}, ${application.check_in} to ${application.check_out}. Open the Enquiries dashboard to review it.`
    }))
  );
  const whatsApp = sendWhatsAppAutomation({
    event: 'BOOKING_REQUEST_RECEIVED',
    phone: guest.whatsapp_number || guest.phone,
    name: guest.full_name,
    bookingReference: `APP-${application.id}`,
    propertyId: property.property_code || property.id,
    propertyName: property.property_name,
    checkIn: application.check_in,
    checkOut: application.check_out,
    guestsCount: Number(application.adults || 0) + Number(application.children || 0) + Number(application.infants || 0),
    amount: application.quoted_total_amount || application.quoted_amount,
    status: application.status
  });
  const results = await Promise.allSettled([guestEmail, ...adminEmails, whatsApp]);
  results.filter(result => result.status === 'rejected').forEach(result => console.error('Application notification failed:', result.reason));
};

module.exports = { notifyApplicationSubmitted };
