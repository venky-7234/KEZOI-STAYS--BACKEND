const crypto = require('crypto');

const decode = value => Buffer.from(String(value || ''), 'base64');

const decryptFlowRequest = body => {
  const privateKey = String(process.env.META_FLOW_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!privateKey) throw new Error('META_FLOW_PRIVATE_KEY is not configured');
  const aesKey = crypto.privateDecrypt({
    key: privateKey,
    passphrase: process.env.META_FLOW_PRIVATE_KEY_PASSPHRASE || undefined,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256'
  }, decode(body.encrypted_aes_key));
  const iv = decode(body.initial_vector);
  const encrypted = decode(body.encrypted_flow_data);
  const ciphertext = encrypted.subarray(0, -16);
  const authTag = encrypted.subarray(-16);
  const algorithm = `aes-${aesKey.length * 8}-gcm`;
  const decipher = crypto.createDecipheriv(algorithm, aesKey, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return { data: JSON.parse(plaintext.toString('utf8')), aesKey, iv };
};

const encryptFlowResponse = (response, aesKey, iv) => {
  const flippedIv = Buffer.from(iv.map(byte => ~byte & 0xff));
  const algorithm = `aes-${aesKey.length * 8}-gcm`;
  const cipher = crypto.createCipheriv(algorithm, aesKey, flippedIv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(response), 'utf8'), cipher.final()]);
  return Buffer.concat([ciphertext, cipher.getAuthTag()]).toString('base64');
};

const verifyMetaSignature = (rawBody, signature) => {
  const secret = process.env.META_APP_SECRET;
  if (!secret || !rawBody || !signature?.startsWith('sha256=')) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

module.exports = { decryptFlowRequest, encryptFlowResponse, verifyMetaSignature };
