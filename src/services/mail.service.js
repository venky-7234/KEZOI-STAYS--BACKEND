const { Resend } = require("resend");

let resendClient;

function getResendClient() {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured");
  }

  if (!resendClient) {
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }

  return resendClient;
}

async function sendEmail({ to, subject, html, text }) {
  if (typeof to !== "string" || !to.trim()) {
    throw new Error("A recipient email address is required");
  }

  if (!subject || (!html && !text)) {
    throw new Error("Email subject and content are required");
  }

  if (!process.env.EMAIL_FROM) {
    throw new Error("EMAIL_FROM is not configured");
  }

  const message = {
    from: process.env.EMAIL_FROM,
    to: [to.trim()],
    subject,
  };

  if (html) message.html = html;
  if (text) message.text = text;

  if (process.env.EMAIL_REPLY_TO) {
    message.replyTo = process.env.EMAIL_REPLY_TO;
  }

  const { data, error } = await getResendClient().emails.send(message);

  if (error) {
    throw new Error(`Resend email failed: ${error.message}`);
  }

  if (!data?.id) {
    throw new Error("Resend did not return an email ID");
  }

  return { id: data.id };
}

module.exports = { sendEmail };