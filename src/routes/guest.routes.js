const express = require('express');

const {
  createGuest,
  getGuests,
  getGuestById,
  updateGuest
} = require('../controllers/guest.controller');

const authenticate = require('../middleware/auth.middleware');

const router = express.Router();

router.use(authenticate);

router.post('/', createGuest);

router.get('/', getGuests);

router.get('/:id', getGuestById);

router.patch('/:id', updateGuest);

module.exports = router;