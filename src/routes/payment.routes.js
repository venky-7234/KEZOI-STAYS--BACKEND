const express = require('express');

const {
  createPayment,
  getPayments,
  getPaymentById,
  updatePaymentStatus
} = require('../controllers/payment.controller');

const authenticate =
  require('../middleware/auth.middleware');

const router = express.Router();

router.use(authenticate);

router.post(
  '/',
  createPayment
);

router.get(
  '/',
  getPayments
);

router.get(
  '/:id',
  getPaymentById
);

router.patch(
  '/:id/status',
  updatePaymentStatus
);

module.exports = router;