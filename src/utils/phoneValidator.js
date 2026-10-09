const { parsePhoneNumberFromString } = require('libphonenumber-js/max');

const INVALID_MOBILE_MESSAGE = 'Please enter a valid mobile number';

/**
 * Validates a mobile number and normalizes it to E.164.
 * Numbers without an international calling code use defaultCountry (India by default).
 */
const validatePhoneNumber = (value, defaultCountry = 'IN') => {
  const input = String(value ?? '').trim();
  const country = String(defaultCountry || 'IN').trim().toUpperCase();

  if (!input || !/^[+\d\s().-]+$/.test(input) || !/^[A-Z]{2}$/.test(country)) {
    return { valid: false, normalizedNumber: null, message: INVALID_MOBILE_MESSAGE };
  }

  try {
    const phoneNumber = input.startsWith('+')
      ? parsePhoneNumberFromString(input)
      : parsePhoneNumberFromString(input, country);
    const type = phoneNumber?.getType();
    const isMobile = type === 'MOBILE' || type === 'FIXED_LINE_OR_MOBILE';

    if (!phoneNumber || !phoneNumber.isPossible() || !phoneNumber.isValid() || !isMobile) {
      return { valid: false, normalizedNumber: null, message: INVALID_MOBILE_MESSAGE };
    }

    return {
      valid: true,
      normalizedNumber: phoneNumber.number,
      country: phoneNumber.country || null,
      message: null
    };
  } catch (_error) {
    return { valid: false, normalizedNumber: null, message: INVALID_MOBILE_MESSAGE };
  }
};

module.exports = { INVALID_MOBILE_MESSAGE, validatePhoneNumber };
