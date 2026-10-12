const pool = require('../src/config/database');

(async () => {
  const result = await pool.query(
    `SELECT id, status, document_verification_status
       FROM enquiries
      WHERE status = 'QUALIFIED'
        AND document_verification_status IS DISTINCT FROM 'VERIFIED'
      ORDER BY id`
  );
  console.log(JSON.stringify({ count: result.rowCount, enquiries: result.rows }, null, 2));
})()
  .catch(error => {
    console.error('Enquiry workflow audit failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
