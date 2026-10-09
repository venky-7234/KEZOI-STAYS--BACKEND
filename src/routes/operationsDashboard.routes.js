const express = require('express');

const {
  getPropertyOperationsSummary,
  getOperationsDashboardSummary
} = require('../controllers/operationsDashboard.controller');

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

router.get(
  '/summary',
  getOperationsDashboardSummary
);

router.get(
  '/properties/:propertyId',
  getPropertyOperationsSummary
);

module.exports = router;