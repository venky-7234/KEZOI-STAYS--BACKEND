const dns = require('dns').promises;
const net = require('net');
const sharp = require('sharp');

const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
// Meta caps the complete data-channel payload at 1 MB. Keep each of the three
// carousel images below 240 KB so base64 expansion and the remaining JSON fit.
const MAX_META_BYTES = 240 * 1024;
const ALLOWED_IMAGE_HOSTS = new Set(
  String(process.env.PROPERTY_IMAGE_HOSTS || 'vioraelite.s3.eu-north-1.amazonaws.com')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
);

const isPrivateAddress = address => net.isIP(address) && (
  address === '::1' || address.startsWith('127.') || address.startsWith('10.') ||
  address.startsWith('192.168.') || address.startsWith('169.254.') ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(address) || address.startsWith('fc') || address.startsWith('fd')
);

const validateImageUrl = async value => {
  let url;
  try { url = new URL(String(value || '')); } catch (_error) { throw new Error('A valid image_url is required'); }
  if (url.protocol !== 'https:' || !ALLOWED_IMAGE_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password) {
    throw new Error('image_url must use HTTPS on an approved property-image host');
  }
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) throw new Error('image_url resolved to a disallowed network address');
  return url;
};

const download = async url => {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg' } });
  if (!response.ok) throw new Error(`Unable to download image (HTTP ${response.status})`);
  const type = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
  if (!['image/webp', 'image/jpeg', 'image/png'].includes(type)) throw new Error('S3 URL did not return a supported image');
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_SOURCE_BYTES) throw new Error('Source image exceeds 12 MB');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_SOURCE_BYTES) throw new Error('Source image is empty or exceeds 12 MB');
  return bytes;
};

const toMetaJpeg = async source => {
  for (const [width, quality] of [[1600, 78], [1280, 72], [1024, 66], [800, 60], [640, 54]]) {
    const output = await sharp(source, { limitInputPixels: 40_000_000 }).rotate()
      .resize({ width, height: Math.round(width * 0.75), fit: 'cover', position: 'attention', withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true }).toBuffer();
    if (output.length <= MAX_META_BYTES) return output;
  }
  throw new Error('Converted carousel image exceeds the safe 240 KB per-image budget');
};

const imageUrlToMetaBase64 = async value => {
  const url = await validateImageUrl(value);
  return (await toMetaJpeg(await download(url))).toString('base64');
};

module.exports = { imageUrlToMetaBase64, validateImageUrl, toMetaJpeg };
