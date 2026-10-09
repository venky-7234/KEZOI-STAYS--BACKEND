const fs = require('fs');
const path = require('path');
const pool = require('../src/config/database');

async function migrate() {
  const sql = fs.readFileSync(path.resolve(__dirname, '../migrations/004_mobile_discount_offers.sql'), 'utf8');
  await pool.query(sql);
  console.log('Mobile discount offers migration completed');
  await pool.end();
}

migrate().catch(async error => {
  console.error('Mobile discount offers migration failed:', error.message);
  await pool.end();
  process.exit(1);
});
