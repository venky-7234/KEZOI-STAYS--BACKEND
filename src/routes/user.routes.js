const express = require('express');

const {
  getUsers,
  getUserById,
  createUser,
  updateUser,
  resetUserPassword,
  deleteUser
} = require('../controllers/user.controller');

const authenticate =
  require('../middleware/auth.middleware');

const authorizeRoles =
  require('../middleware/role.middleware');

const router = express.Router();

router.use(authenticate);

// Only SUPER_ADMIN can manage staff/users
router.use(
  authorizeRoles('SUPER_ADMIN')
);

router.get(
  '/',
  getUsers
);

router.get(
  '/:id',
  getUserById
);

router.post(
  '/',
  createUser
);

router.patch(
  '/:id',
  updateUser
);

router.patch(
  '/:id/password',
  resetUserPassword
);

router.delete(
  '/:id',
  deleteUser
);

module.exports = router;
