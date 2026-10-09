const { Resend } = require("resend");

let client;

async function sendEmail({ to, subject, html, text }) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    throw new Error("RESEND_API_KEY or EMAIL_FROM is missing");
  }

  if (typeof to !== "string" || !to.trim()) {
    throw new Error("Recipient email is required");
  }

  if (!subject || (!html && !text)) {
    throw new Error("Email subject and content are required");
  }

  client ??= new Resend(process.env.RESEND_API_KEY);

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

  const { data, error } = await client.emails.send(message);

  if (error) {
    throw new Error(`Resend: ${error.message}`);
  }

  if (!data?.id) {
    throw new Error("Resend did not return an email ID");
  }

  return { id: data.id };
}

module.exports = { sendEmail };