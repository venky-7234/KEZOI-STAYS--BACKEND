const pool = require('../config/database');
const { findAvailableProperties } = require('../services/availability.service');
const { decryptFlowRequest, encryptFlowResponse, verifyMetaSignature } = require('../services/metaFlowCrypto.service');

const dataExchange = async (req, res) => {
  if (!verifyMetaSignature(req.rawBody, req.headers['x-hub-signature-256'])) {
    return res.status(432).type('text/plain').send('Invalid signature');
  }
  try {
    const decrypted = decryptFlowRequest(req.body);
    const payload = decrypted.data;
    let response;
    if (payload.action === 'ping') {
      response = { data: { status: 'active' } };
    } else if (payload.action === 'data_exchange' && payload.screen === 'BOOKING_DETAILS') {
      const input = payload.data || {};
      const guests = Number(input.guests);
      const result = await findAvailableProperties(pool, {
        check_in: input.check_in, check_out: input.check_out,
        adults: guests, children: 0, infants: 0, pets: 0
      });
      if (result.error) {
        response = { screen: 'BOOKING_DETAILS', data: { error_message: result.error } };
      } else {
        response = {
          screen: 'PROPERTY_SELECTION',
          data: {
            check_in: result.stay.check_in,
            check_out: result.stay.check_out,
            guests: String(guests),
            properties: result.properties.map(item => ({
              id: String(item.id),
              title: item.property_name,
              description: `${item.bedrooms || 0} bedrooms | ${item.bathrooms || 0} bathrooms | ${item.quote.currency} ${item.quote.total_amount}`
            })),
            quote_generated_at: new Date().toISOString(),
            no_properties_available: result.properties.length === 0
          }
        };
      }
    } else {
      response = { screen: payload.screen || 'BOOKING_DETAILS', data: { error_message: 'Unsupported Flow action or screen' } };
    }
    return res.status(200).type('text/plain').send(encryptFlowResponse(response, decrypted.aesKey, decrypted.iv));
  } catch (error) {
    console.error('Meta Flow data exchange error:', error.message);
    return res.status(500).type('text/plain').send('Unable to process encrypted Flow request');
  }
};

const health = (_req, res) => res.json({
  success: true,
  service: 'meta-flow-data-exchange',
  configured: Boolean(process.env.META_FLOW_PRIVATE_KEY && process.env.META_APP_SECRET)
});

module.exports = { dataExchange, health };
