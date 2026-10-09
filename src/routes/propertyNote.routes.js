const express = require('express');

const {
  createPropertyNote,
  getPropertyNotes,
  updatePropertyNote,
  deletePropertyNote
} = require('../controllers/propertyNote.controller');

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
  createPropertyNote
);

router.get(
  '/property/:propertyId',
  getPropertyNotes
);

router.patch(
  '/:id',
  updatePropertyNote
);

router.delete(
  '/:id',
  deletePropertyNote
);

module.exports = router;