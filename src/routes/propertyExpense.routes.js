const express = require('express');

const {
  createPropertyExpense,
  getPropertyExpenses,
  getPropertyExpenseById,
  updatePropertyExpense,
  getPropertyExpenseSummary,
  deletePropertyExpense
} = require('../controllers/propertyExpense.controller');

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
  createPropertyExpense
);

router.get(
  '/',
  getPropertyExpenses
);

router.get(
  '/property/:propertyId/summary',
  getPropertyExpenseSummary
);

router.get(
  '/:id',
  getPropertyExpenseById
);

router.patch(
  '/:id',
  updatePropertyExpense
);

router.delete(
  '/:id',
  deletePropertyExpense
);

module.exports = router;