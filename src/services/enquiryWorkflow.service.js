const NORMAL_STATUSES = Object.freeze(['NEW', 'CONTACTED', 'QUOTED', 'FOLLOW_UP']);
const TERMINAL_STATUSES = Object.freeze(['LOST', 'CANCELLED']);
const SPECIAL_STATUSES = Object.freeze(['QUALIFIED', 'CONVERTED']);
const ALLOWED_STATUSES = Object.freeze([
  ...NORMAL_STATUSES,
  ...SPECIAL_STATUSES,
  ...TERMINAL_STATUSES
]);

const NORMAL_TRANSITIONS = Object.freeze({
  NEW: new Set(['CONTACTED', 'QUOTED', 'FOLLOW_UP', 'LOST', 'CANCELLED']),
  CONTACTED: new Set(['NEW', 'QUOTED', 'FOLLOW_UP', 'LOST', 'CANCELLED']),
  QUOTED: new Set(['CONTACTED', 'FOLLOW_UP', 'LOST', 'CANCELLED']),
  FOLLOW_UP: new Set(['CONTACTED', 'QUOTED', 'LOST', 'CANCELLED']),
  QUALIFIED: new Set(['FOLLOW_UP', 'LOST', 'CANCELLED']),
  CONVERTED: new Set(),
  LOST: new Set(),
  CANCELLED: new Set()
});

const APPROVABLE_STATUSES = Object.freeze(new Set(NORMAL_STATUSES));

class EnquiryTransitionError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = 'EnquiryTransitionError';
    this.code = code;
    this.status = status;
  }
}

const normalizeEnquiryStatus = value => String(value || '').trim().toUpperCase();

const validateGenericTransition = ({ currentStatus, requestedStatus, role, hasActiveBooking = false }) => {
  const current = normalizeEnquiryStatus(currentStatus);
  const requested = normalizeEnquiryStatus(requestedStatus);

  if (!ALLOWED_STATUSES.includes(requested)) {
    throw new EnquiryTransitionError('INVALID_STATUS', 'Invalid enquiry status', 400);
  }
  if (current === requested) return { changed: false, status: current };
  if (requested === 'QUALIFIED') {
    throw new EnquiryTransitionError(
      'APPROVAL_REQUIRED',
      'Use the application approval endpoint after verifying the identity document'
    );
  }
  if (requested === 'CONVERTED') {
    throw new EnquiryTransitionError(
      'BOOKING_CONVERSION_REQUIRED',
      'Create a linked booking to convert this enquiry'
    );
  }
  if (TERMINAL_STATUSES.includes(requested) && !['SUPER_ADMIN', 'ADMIN'].includes(role)) {
    throw new EnquiryTransitionError(
      'STATUS_PERMISSION_REQUIRED',
      'Only an admin can mark an enquiry lost or cancelled',
      403
    );
  }
  if (TERMINAL_STATUSES.includes(requested) && hasActiveBooking) {
    throw new EnquiryTransitionError(
      'ACTIVE_BOOKING_EXISTS',
      'The linked active booking must be handled through the booking workflow'
    );
  }
  if (!NORMAL_TRANSITIONS[current]?.has(requested)) {
    throw new EnquiryTransitionError(
      'INVALID_STATUS_TRANSITION',
      `Enquiry cannot transition from ${current || 'UNKNOWN'} to ${requested}`
    );
  }
  return { changed: true, status: requested };
};

const validateApproval = ({ currentStatus, documentPath, documentVerificationStatus }) => {
  const current = normalizeEnquiryStatus(currentStatus);
  if (!documentPath || normalizeEnquiryStatus(documentVerificationStatus) !== 'VERIFIED') {
    throw new EnquiryTransitionError(
      'DOCUMENT_VERIFICATION_REQUIRED',
      'Application cannot be approved until its identity document is uploaded and verified'
    );
  }
  if (current === 'QUALIFIED') return { changed: false, status: current };
  if (!APPROVABLE_STATUSES.has(current)) {
    throw new EnquiryTransitionError(
      'INVALID_STATUS_TRANSITION',
      `Enquiry cannot transition from ${current || 'UNKNOWN'} to QUALIFIED`
    );
  }
  return { changed: true, status: 'QUALIFIED' };
};

const validateBookingConversion = enquiry => {
  if (!enquiry) {
    throw new EnquiryTransitionError('ENQUIRY_NOT_FOUND', 'Enquiry not found', 404);
  }
  if (String(enquiry.source || '').toUpperCase() === 'WEBSITE' ||
      String(enquiry.source || '').toUpperCase() === 'TG-0001') {
    if (normalizeEnquiryStatus(enquiry.status) !== 'QUALIFIED' ||
        normalizeEnquiryStatus(enquiry.document_verification_status) !== 'VERIFIED') {
      throw new EnquiryTransitionError(
        'APPLICATION_APPROVAL_REQUIRED',
        'Website applications require a verified document and approval before booking conversion'
      );
    }
  }
  return true;
};

module.exports = {
  ALLOWED_STATUSES,
  NORMAL_STATUSES,
  TERMINAL_STATUSES,
  APPROVABLE_STATUSES,
  EnquiryTransitionError,
  normalizeEnquiryStatus,
  validateGenericTransition,
  validateApproval,
  validateBookingConversion
};
