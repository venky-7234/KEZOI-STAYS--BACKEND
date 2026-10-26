const express = require('express');
const {
  testWhatsAppAutomation
} = require('../controllers/whatsapp.controller');

const router = express.Router();

router.post(
  '/',
  testWhatsAppAutomation
);

module.exports = router;
