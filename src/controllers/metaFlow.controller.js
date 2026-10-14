const pool = require('../config/database');
const { handleFlowAction } = require('../services/metaFlowBooking.service');
const {
  decryptFlowRequest,
  encryptFlowResponse,
  getMetaFlowConfiguration,
  verifyMetaSignature
} = require('../services/metaFlowCrypto.service');

const dataExchange = async (req, res) => {
  if (!verifyMetaSignature(req.rawBody, req.headers['x-hub-signature-256'])) {
    const configuration = getMetaFlowConfiguration();
    console.warn('Meta Flow signature verification failed', {
      appSecretConfigured: configuration.appSecretConfigured,
      rawBodyCaptured: Buffer.isBuffer(req.rawBody),
      signatureHeaderPresent: Boolean(req.headers['x-hub-signature-256'])
    });
    return res.status(432).type('text/plain').send('Invalid signature');
  }
  try {
    const decrypted = decryptFlowRequest(req.body);
    const response = await handleFlowAction(pool, decrypted.data);
    return res.status(200).type('text/plain').send(encryptFlowResponse(response, decrypted.aesKey, decrypted.iv));
  } catch (error) {
    console.error('Meta Flow data exchange error:', error.message);
    return res.status(500).type('text/plain').send('Unable to process encrypted Flow request');
  }
};

const health = (_req, res) => {
  const configuration = getMetaFlowConfiguration();
  return res.json({
    success: true,
    service: 'meta-flow-data-exchange',
    ...configuration
  });
};

module.exports = { dataExchange, health };
