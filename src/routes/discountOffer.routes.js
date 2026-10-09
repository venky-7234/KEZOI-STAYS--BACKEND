const express = require('express');
const authenticate = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/role.middleware');
const controller = require('../controllers/discountOffer.controller');

const router = express.Router();
router.use(authenticate, authorizeRoles('SUPER_ADMIN', 'ADMIN'));
router.get('/', controller.listDiscountOffers);
router.post('/', controller.saveDiscountOffer);
router.patch('/:id/deactivate', controller.deactivateDiscountOffer);

module.exports = router;
