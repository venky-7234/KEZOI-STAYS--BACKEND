const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateExclusiveGst } = require('../src/utils/gstCalculator');

test('calculates 18% exclusive GST for one TG-0001 night', () => {
  assert.deepEqual(calculateExclusiveGst({ baseAmount: 9999, gstRate: 18 }), {
    gross_amount: 9999,
    taxable_amount: 9999,
    gst_rate: 18,
    cgst_rate: 9,
    cgst_amount: 899.91,
    sgst_rate: 9,
    sgst_amount: 899.91,
    igst_rate: 0,
    igst_amount: 0,
    gst_amount: 1799.82,
    total_amount: 11798.82
  });
});

test('taxes extra guests and applies discount before GST', () => {
  const result = calculateExclusiveGst({
    baseAmount: 9999,
    extraGuestAmount: 1528,
    discountAmount: 500,
    gstRate: 18
  });
  assert.equal(result.taxable_amount, 11027);
  assert.equal(result.gst_amount, 1984.86);
  assert.equal(result.total_amount, 13011.86);
});

test('supports GST-disabled properties without changing payable amount', () => {
  const result = calculateExclusiveGst({ baseAmount: 9999, gstEnabled: false });
  assert.equal(result.gst_amount, 0);
  assert.equal(result.total_amount, 9999);
});

test('rejects a discount greater than the gross amount', () => {
  assert.throws(
    () => calculateExclusiveGst({ baseAmount: 100, discountAmount: 101 }),
    /Discount cannot exceed/
  );
});
