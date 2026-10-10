const test = require('node:test');
const assert = require('node:assert/strict');
const { parseStay } = require('../src/services/availability.service');

test('parses the current Flow guests field as adults through caller mapping', () => {
  const stay = parseStay({ check_in: '2026-11-01', check_out: '2026-11-03', adults: '2' });
  assert.equal(stay.nights, 2);
  assert.equal(stay.total_occupants, 2);
});

test('rejects reversed dates', () => {
  assert.match(parseStay({ check_in: '2026-11-03', check_out: '2026-11-01', adults: 2 }).error, /after/);
});

test('rejects invalid guest counts', () => {
  assert.match(parseStay({ check_in: '2026-11-01', check_out: '2026-11-03', adults: 0 }).error, /at least 1/);
});
