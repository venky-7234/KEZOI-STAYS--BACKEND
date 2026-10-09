const express = require('express');
const uploadIdentity = require('../middleware/identityUpload.middleware');
const controller = require('../controllers/application.controller');

const router = express.Router();

router.get('/properties', controller.listPublicProperties);
router.get('/properties/:id/unavailable-dates', controller.getUnavailableDates);
router.get('/properties/:id/quote', controller.getQuote);
router.post('/quote', controller.getQuote);
router.post('/validate-contact', controller.requestVerification);
router.post('/verification/request', controller.requestVerification);
router.post('/verification/confirm', controller.confirmVerification);
router.post('/submit', (req, res, next) => {
  uploadIdentity.single('identity_document')(req, res, error => {
    if (!error) return next();
    return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      success: false,
      message: error.code === 'LIMIT_FILE_SIZE' ? 'Identity document must not exceed 5 MB' : error.message
    });
  });
}, controller.submitApplication);

module.exports = router;
