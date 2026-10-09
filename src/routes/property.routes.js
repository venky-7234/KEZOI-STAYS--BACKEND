const express = require('express');

const {
  createProperty,
  getProperties,
  getPropertyById,
  updateProperty,
  createPropertyBlock,
  getPropertyBlocks,
  deletePropertyBlock,
  checkAvailability
} = require('../controllers/property.controller');

const authenticate = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/role.middleware');

const router = express.Router();

router.use(authenticate);

// Property CRUD
router.post('/', authorizeRoles('SUPER_ADMIN'), createProperty);
router.get('/', getProperties);

router.get('/:id/availability', checkAvailability);

router.post('/:id/blocks', authorizeRoles('SUPER_ADMIN'), createPropertyBlock);
router.get('/:id/blocks', getPropertyBlocks);

router.delete(
  '/blocks/:blockId',
  authorizeRoles('SUPER_ADMIN'),
  deletePropertyBlock
);

router.get('/:id', getPropertyById);
router.patch('/:id', authorizeRoles('SUPER_ADMIN'), updateProperty);

module.exports = router;
