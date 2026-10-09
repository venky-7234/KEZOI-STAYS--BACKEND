const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INTERNATIONAL_MOBILE_PATTERN = /^\+[1-9]\d{7,14}$/;

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const normalizeMobile = (value) => {
  const raw = String(value || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return `+${digits}`;
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`;
  return `+${digits}`;
};

const isValidEmail = (value) => EMAIL_PATTERN.test(normalizeEmail(value));
const isValidInternationalMobile = value => INTERNATIONAL_MOBILE_PATTERN.test(normalizeMobile(value));

const parsePositiveInteger = (value, fallback = 0) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

const parseDateOnly = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

module.exports = {
  normalizeEmail,
  normalizeMobile,
  isValidEmail,
  isValidInternationalMobile,
  parsePositiveInteger,
  parseDateOnly
};
