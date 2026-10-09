const express = require('express');

const {
  createPublicEnquiry,
  createEnquiry,
  getEnquiries,
  getEnquiryById,
  updateEnquiry,
  viewIdentityDocument,
  reviewIdentityDocument,
  approveApplication
} = require('../controllers/enquiry.controller');

const authenticate = require('../middleware/auth.middleware');
const authorizeRoles = require('../middleware/role.middleware');

const router = express.Router();

// ======================================================
// PUBLIC ROUTE
// Used by Kezoi informative website
// ======================================================

router.post(
  '/public',
  (_req, res) => res.status(410).json({
    success: false,
    message: 'Use POST /api/applications/submit with verified email, WhatsApp and identity document'
  })
);


// ======================================================
// PROTECTED DASHBOARD ROUTES
// ======================================================

router.post(
  '/',
  authenticate,
  createEnquiry
);

router.get(
  '/',
  authenticate,
  getEnquiries
);

router.get(
  '/:id/document',
  authenticate,
  authorizeRoles('SUPER_ADMIN', 'ADMIN'),
  viewIdentityDocument
);

router.get(
  '/:id',
  authenticate,
  getEnquiryById
);

router.patch(
  '/:id',
  authenticate,
  updateEnquiry
);

router.patch(
  '/:id/document-status',
  authenticate,
  authorizeRoles('SUPER_ADMIN'),
  reviewIdentityDocument
);

router.patch(
  '/:id/approve',
  authenticate,
  authorizeRoles('SUPER_ADMIN'),
  approveApplication
);


module.exports = router;
