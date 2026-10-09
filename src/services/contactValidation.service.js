const {
  normalizeEmail,
  isValidEmail
} = require('../utils/applicationValidation');
const { validatePhoneNumber } = require('../utils/phoneValidator');

class ContactValidationError extends Error {
  constructor(message, status = 503, code = 'PROVIDER_ERROR') {
    super(message);
    this.name = 'ContactValidationError';
    this.status = status;
    this.code = code;
  }
}

const fetchJson = async (url, options = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false || data.error) {
      throw new ContactValidationError(
        data.message || data.error?.info || `Contact validation provider returned HTTP ${response.status}`,
        503,
        'PROVIDER_RESPONSE_ERROR'
      );
    }
    return data;
  } catch (error) {
    if (error instanceof ContactValidationError) throw error;
    throw new ContactValidationError(
      error.name === 'AbortError'
        ? 'Contact validation provider timed out'
        : 'Contact validation provider is unavailable',
      503,
      error.name === 'AbortError' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE'
    );
  } finally {
    clearTimeout(timeout);
  }
};

const validateExistingEmail = async value => {
  const email = normalizeEmail(value);
  if (!isValidEmail(email)) return { valid: false, value: email, reason: 'INVALID_FORMAT' };

  const apiKey = process.env.CHECK_MAIL_API_KEY;
  if (!apiKey) {
    throw new ContactValidationError('Email validation is not configured');
  }

  const data = await fetchJson('https://api.check-mail.org/v2/', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ email })
  });

  const valid = data.valid === true && data.block === false && data.is_disposable !== true;
  return {
    valid,
    verified: true,
    value: email,
    reason: valid ? null : data.is_disposable ? 'DISPOSABLE_EMAIL' : 'EMAIL_NOT_VALID',
    risk: Number.isFinite(Number(data.risk)) ? Number(data.risk) : null
  };
};

const validateExistingPhone = async (value, defaultCountry = 'IN') => {
  const result = validatePhoneNumber(value, defaultCountry);
  return {
    valid: result.valid,
    value: result.normalizedNumber,
    reason: result.valid ? null : 'INVALID_FORMAT',
    country: result.country || null
  };
};

const validateApplicationContacts = async ({ email, phone, phoneCountry = 'IN' }) => {
  const phoneResult = await validateExistingPhone(phone, phoneCountry);
  let emailResult;
  try {
    emailResult = await validateExistingEmail(email);
  } catch (error) {
    if (!(error instanceof ContactValidationError) ||
        !['PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE'].includes(error.code)) {
      throw error;
    }
    const normalizedEmail = normalizeEmail(email);
    emailResult = {
      valid: isValidEmail(normalizedEmail),
      verified: false,
      value: normalizedEmail,
      reason: 'PROVIDER_UNAVAILABLE',
      risk: null
    };
    console.warn(`Email validation soft-failed: ${error.message}`);
  }
  return { email: emailResult, phone: phoneResult };
};

module.exports = {
  ContactValidationError,
  validateExistingEmail,
  validateExistingPhone,
  validateApplicationContacts
};
