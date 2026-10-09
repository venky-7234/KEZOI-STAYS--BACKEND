const express = require('express');

const {
  createBooking,
  getBookings,
  getBookingById,
  updateBookingStatus,
  updateBookingDiscount
} = require('../controllers/booking.controller');

const authenticate =
  require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/role.middleware');

const router = express.Router();

router.use(authenticate);

router.post(
  '/',
  createBooking
);

router.get(
  '/',
  getBookings
);

router.get(
  '/:id',
  getBookingById
);

router.patch(
  '/:id/status',
  updateBookingStatus
);

router.patch(
  '/:id/discount',
  authorizeRoles('SUPER_ADMIN', 'ADMIN'),
  updateBookingDiscount
);

module.exports = router;
