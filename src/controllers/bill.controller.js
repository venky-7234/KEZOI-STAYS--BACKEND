const scanBill = async (_req, res) => res.status(501).json({
  success: false,
  message: 'Bill scanning is not configured'
});

module.exports = { scanBill };
