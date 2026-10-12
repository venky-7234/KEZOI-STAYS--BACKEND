const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EnquiryTransitionError,
  validateGenericTransition,
  validateApproval,
  validateBookingConversion
} = require('../src/services/enquiryWorkflow.service');

const expectWorkflowError = (fn, code, status = 409) => {
  assert.throws(fn, error => {
    assert.ok(error instanceof EnquiryTransitionError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
};

test('allows NEW to CONTACTED', () => {
  assert.deepEqual(validateGenericTransition({ currentStatus: 'NEW', requestedStatus: 'CONTACTED', role: 'STAFF' }), {
    changed: true,
    status: 'CONTACTED'
  });
});

test('allows NEW to FOLLOW_UP', () => {
  assert.equal(validateGenericTransition({ currentStatus: 'NEW', requestedStatus: 'FOLLOW_UP', role: 'STAFF' }).changed, true);
});

test('generic update cannot set QUALIFIED even with a verified document', () => {
  expectWorkflowError(
    () => validateGenericTransition({ currentStatus: 'NEW', requestedStatus: 'QUALIFIED', role: 'SUPER_ADMIN' }),
    'APPROVAL_REQUIRED'
  );
});

test('generic update cannot set CONVERTED', () => {
  expectWorkflowError(
    () => validateGenericTransition({ currentStatus: 'QUALIFIED', requestedStatus: 'CONVERTED', role: 'SUPER_ADMIN' }),
    'BOOKING_CONVERSION_REQUIRED'
  );
});

test('approval rejects an unverified document', () => {
  expectWorkflowError(
    () => validateApproval({ currentStatus: 'NEW', documentPath: 'uploads/id.pdf', documentVerificationStatus: 'PENDING' }),
    'DOCUMENT_VERIFICATION_REQUIRED'
  );
});

test('approval rejects a rejected document', () => {
  expectWorkflowError(
    () => validateApproval({ currentStatus: 'NEW', documentPath: 'uploads/id.pdf', documentVerificationStatus: 'REJECTED' }),
    'DOCUMENT_VERIFICATION_REQUIRED'
  );
});

test('approval accepts NEW with an uploaded verified document', () => {
  assert.deepEqual(validateApproval({
    currentStatus: 'NEW',
    documentPath: 'uploads/id.pdf',
    documentVerificationStatus: 'VERIFIED'
  }), { changed: true, status: 'QUALIFIED' });
});

test('repeated approval is unchanged so notifications are not repeated', () => {
  assert.deepEqual(validateApproval({
    currentStatus: 'QUALIFIED',
    documentPath: 'uploads/id.pdf',
    documentVerificationStatus: 'VERIFIED'
  }), { changed: false, status: 'QUALIFIED' });
});

test('an inconsistent QUALIFIED enquiry with an unverified document is not treated as approved', () => {
  expectWorkflowError(
    () => validateApproval({
      currentStatus: 'QUALIFIED',
      documentPath: 'uploads/id.pdf',
      documentVerificationStatus: 'PENDING'
    }),
    'DOCUMENT_VERIFICATION_REQUIRED'
  );
});

test('non-admin cannot mark an enquiry lost', () => {
  expectWorkflowError(
    () => validateGenericTransition({ currentStatus: 'NEW', requestedStatus: 'LOST', role: 'STAFF' }),
    'STATUS_PERMISSION_REQUIRED',
    403
  );
});

test('ordinary status updates cannot affect an active linked booking', () => {
  expectWorkflowError(
    () => validateGenericTransition({ currentStatus: 'QUALIFIED', requestedStatus: 'CANCELLED', role: 'ADMIN', hasActiveBooking: true }),
    'ACTIVE_BOOKING_EXISTS'
  );
});

test('booking conversion requires approved verified website application', () => {
  expectWorkflowError(
    () => validateBookingConversion({ source: 'WEBSITE', status: 'NEW', document_verification_status: 'VERIFIED' }),
    'APPLICATION_APPROVAL_REQUIRED'
  );
  assert.equal(validateBookingConversion({
    source: 'WEBSITE', status: 'QUALIFIED', document_verification_status: 'VERIFIED'
  }), true);
});

test('non-application enquiry can be converted by the booking workflow', () => {
  assert.equal(validateBookingConversion({ source: 'PHONE', status: 'CONTACTED', document_verification_status: null }), true);
});
