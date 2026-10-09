const express = require('express');

const {
  createServicePartner,
  getServicePartners,
  getServicePartnerById,
  updateServicePartner,
  deleteServicePartner
} = require('../controllers/servicePartner.controller');

const authenticate =
  require('../middleware/auth.middleware');

const authorizeRoles =
  require('../middleware/role.middleware');

const router = express.Router();

router.use(authenticate);

router.use(
  authorizeRoles(
    'SUPER_ADMIN',
    'OPERATIONS'
  )
);

router.post(
  '/',
  createServicePartner
);

router.get(
  '/',
  getServicePartners
);

router.get(
  '/:id',
  getServicePartnerById
);

router.patch(
  '/:id',
  updateServicePartner
);

router.delete(
  '/:id',
  deleteServicePartner
);

module.exports = router;