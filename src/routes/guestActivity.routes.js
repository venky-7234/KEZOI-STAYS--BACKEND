const express = require('express');

const {
  addGuestNote,
  getGuestNotes,
  addCommunicationLog,
  getCommunicationLogs,
  getGuestTimeline
} = require('../controllers/guestActivity.controller');

const authenticate =
  require('../middleware/auth.middleware');

const router = express.Router();

router.use(authenticate);

router.post(
  '/:guestId/notes',
  addGuestNote
);

router.get(
  '/:guestId/notes',
  getGuestNotes
);

router.post(
  '/:guestId/communications',
  addCommunicationLog
);

router.get(
  '/:guestId/communications',
  getCommunicationLogs
);

router.get(
  '/:guestId/timeline',
  getGuestTimeline
);

module.exports = router;