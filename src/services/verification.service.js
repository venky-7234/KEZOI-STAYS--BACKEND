const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { sendEmail } = require('./mail.service');

const generateCode = () => String(crypto.randomInt(100000, 1000000));
const hashCode = (code) => crypto.createHash('sha256').update(code).digest('hex');

const sendEmailCode = async (email, code) => sendEmail({
  to: email,
  subject: 'Verify your Kezoi Stays application',
  text: `Your Kezoi Stays verification code is ${code}. It expires in 10 minutes.`
});

const createVerificationToken = ({ channel, destination }) => jwt.sign(
  { channel, destination, purpose: 'APPLICATION_VERIFICATION' },
  process.env.JWT_SECRET,
  { expiresIn: '30m' }
);

const readVerificationToken = (token, channel, destination) => {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return payload.purpose === 'APPLICATION_VERIFICATION' &&
      payload.channel === channel && payload.destination === destination;
  } catch (_error) {
    return false;
  }
};

module.exports = {
  generateCode,
  hashCode,
  sendEmailCode,
  createVerificationToken,
  readVerificationToken
};
