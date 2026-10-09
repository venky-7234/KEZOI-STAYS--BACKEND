const {
  normalizeWhatsAppPhone,
  sendWhatsAppAutomation
} = require('../services/whatsapp.service');

const testWhatsAppAutomation = async (req, res) => {
  try {
    const { phone, name = 'Test Guest' } = req.body;

    const normalizedPhone = normalizeWhatsAppPhone(phone);

    if (!normalizedPhone) {
      return res.status(400).json({
        success: false,
        message: 'A valid phone number is required'
      });
    }

    const result = await sendWhatsAppAutomation({
      event: 'TEST_MESSAGE',
      phone: normalizedPhone,
      name,
      message: 'Test WhatsApp message from Kezoi Stays'
    });

    console.log('n8n webhook response:', result.data);

    return res.json({
      success: true,
      message: 'n8n WhatsApp test webhook triggered successfully'
    });
  } catch (error) {
    console.error('n8n WhatsApp webhook failed:', error.message);
    if (error.webhookResponse !== undefined) {
      console.error('n8n webhook response:', error.webhookResponse);
    }

    const status = error.webhookStatus || 502;

    return res.status(status).json({
      success: false,
      message: 'n8n webhook failed',
      status,
      ...(error.webhookResponse
        ? { details: error.webhookResponse }
        : {})
    });
  }
};

module.exports = { testWhatsAppAutomation };
