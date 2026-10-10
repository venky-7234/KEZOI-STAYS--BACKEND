const express = require('express');
const authenticateService = require('../middleware/serviceAuth.middleware');
const controller = require('../controllers/integration.controller');
const router = express.Router();
router.use(authenticateService);
router.post('/availability', controller.availability);
router.post('/enquiries', controller.createEnquiry);
module.exports = router;
