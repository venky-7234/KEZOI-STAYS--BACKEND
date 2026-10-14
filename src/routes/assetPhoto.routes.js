const express = require('express');

const {
  addAssetPhoto,
  getAssetPhotos,
  getPropertyPhotos,
  updateAssetPhoto,
  deleteAssetPhoto,
  listMarketingPhotos,
  addMarketingPhoto,
  updateMarketingPhoto
} = require('../controllers/assetPhoto.controller');

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
  addAssetPhoto
);

router.post('/marketing', addMarketingPhoto);
router.get('/marketing/property/:propertyId', listMarketingPhotos);
router.patch('/marketing/:id', updateMarketingPhoto);

router.get(
  '/asset/:assetId',
  getAssetPhotos
);

router.get(
  '/property/:propertyId',
  getPropertyPhotos
);

router.patch(
  '/:id',
  updateAssetPhoto
);

router.delete(
  '/:id',
  deleteAssetPhoto
);

module.exports = router;
