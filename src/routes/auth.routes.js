const express = require('express');

const {
  login,
  getMe
} = require('../controllers/auth.controller');
const {
  createUser
} = require('../controllers/user.controller');

const authenticate = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/role.middleware');

const router = express.Router();

router.post('/login', login);

router.get(
  '/me',
  authenticate,
  getMe
);

router.post(
  '/register',
  authenticate,
  authorizeRoles('SUPER_ADMIN'),
  createUser
);

module.exports = router;
