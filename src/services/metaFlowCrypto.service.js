const crypto = require('crypto');

const decode = value => Buffer.from(String(value || ''), 'base64');

const getPrivateKey = () => String(process.env.META_FLOW_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const getMetaFlowConfiguration = () => {
  const appSecretConfigured = Boolean(process.env.META_APP_SECRET);
  const privateKey = getPrivateKey();
  const privateKeyConfigured = Boolean(privateKey);
  let privateKeyValid = false;
  let publicKeyFingerprint = null;

  if (privateKeyConfigured) {
    try {
      const key = crypto.createPrivateKey({
        key: privateKey,
        passphrase: process.env.META_FLOW_PRIVATE_KEY_PASSPHRASE || undefined
      });
      const publicKey = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
      privateKeyValid = true;
      publicKeyFingerprint = crypto.createHash('sha256').update(publicKey).digest('hex');
    } catch (_error) {
      // Readiness reports only validity, never key material or passphrases.
    }
  }

  return {
    configured: appSecretConfigured && privateKeyConfigured && privateKeyValid,
    appSecretConfigured,
    privateKeyConfigured,
    privateKeyValid,
    publicKeyFingerprint
  };
};

const decryptFlowRequest = body => {
  const privateKey = getPrivateKey();
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
  if (!secret || !Buffer.isBuffer(rawBody) || !/^sha256=[a-fA-F0-9]{64}$/.test(signature || '')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(signature.slice('sha256='.length), 'hex');
  return crypto.timingSafeEqual(expected, received);
};

module.exports = {
  decryptFlowRequest,
  encryptFlowResponse,
  getMetaFlowConfiguration,
  verifyMetaSignature
};
