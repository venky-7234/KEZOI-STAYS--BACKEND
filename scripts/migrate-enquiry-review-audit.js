const fs = require('fs');
const path = require('path');
const pool = require('../src/config/database');

(async () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../migrations/007_enquiry_review_audit.sql'), 'utf8');
  await pool.query(sql);
  console.log('Enquiry review audit migration completed');
})()
  .catch(error => {
    console.error('Enquiry review audit migration failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
