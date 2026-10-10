const express = require('express');
const controller = require('../controllers/metaFlow.controller');
const router = express.Router();
router.get('/health', controller.health);
router.post('/booking', controller.dataExchange);
module.exports = router;
