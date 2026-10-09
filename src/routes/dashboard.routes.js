const express = require('express');

const {
  getDashboardSummary,
  getRevenueSummary,
  getPropertyOccupancy,
  getDashboardAnalytics
} = require('../controllers/dashboard.controller');

const authenticate =
  require('../middleware/auth.middleware');
const authorizeRoles =
  require('../middleware/role.middleware');

const router = express.Router();

router.use(authenticate);
router.use(
  authorizeRoles('SUPER_ADMIN', 'ADMIN')
);

router.get(
  '/summary',
  getDashboardSummary
);

router.get(
  '/revenue',
  getRevenueSummary
);

router.get(
  '/occupancy',
  getPropertyOccupancy
);

router.get(
  '/analytics',
  getDashboardAnalytics
);

module.exports = router;
