const express = require('express');

const {
  createMaintenanceRequest,
  getMaintenanceRequests,
  getMaintenanceById,
  updateMaintenance,
  getPropertyMaintenanceSummary,
  deleteMaintenance
} = require('../controllers/maintenance.controller');

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
  createMaintenanceRequest
);

router.get(
  '/',
  getMaintenanceRequests
);

router.get(
  '/property/:propertyId/summary',
  getPropertyMaintenanceSummary
);

router.get(
  '/:id',
  getMaintenanceById
);

router.patch(
  '/:id',
  updateMaintenance
);

router.delete(
  '/:id',
  deleteMaintenance
);

module.exports = router;