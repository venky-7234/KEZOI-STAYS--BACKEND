const express = require('express');

const router = express.Router();

const upload =
  require('../middleware/billUpload.middleware');

const {
  scanBill
} = require('../controllers/bill.controller');

router.post(
  '/scan',
  upload.single('bill'),
  scanBill
);

module.exports = router;
