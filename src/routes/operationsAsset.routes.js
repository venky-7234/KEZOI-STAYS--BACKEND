const express = require('express');

const {
  createAsset,
  getAssets,
  getAssetById,
  updateAsset,
  getPropertyAssetSummary,
  deleteAsset
} = require('../controllers/operationsAsset.controller');

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
  createAsset
);

router.get(
  '/',
  getAssets
);

router.get(
  '/property/:propertyId/summary',
  getPropertyAssetSummary
);

router.get(
  '/:id',
  getAssetById
);

router.patch(
  '/:id',
  updateAsset
);

router.delete(
  '/:id',
  deleteAsset
);

module.exports = router;