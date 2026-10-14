const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { toMetaJpeg } = require('../src/services/metaImage.service');

test('converts WebP property images to JPEG within the three-image data-channel budget', async () => {
  const webp = await sharp({ create: { width: 2200, height: 1400, channels: 3, background: '#785f48' } }).webp().toBuffer();
  const jpeg = await toMetaJpeg(webp);
  const metadata = await sharp(jpeg).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.ok(jpeg.length <= 240 * 1024);
  assert.ok(metadata.width <= 1600);
});
