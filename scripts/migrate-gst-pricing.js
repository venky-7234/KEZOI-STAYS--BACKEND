const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: process.env.ENV_FILE || '.env' });
const pool = require('../src/config/database');

async function migrate() {
  const sql = fs.readFileSync(path.resolve(__dirname, '../migrations/005_gst_pricing.sql'), 'utf8');
  await pool.query(sql);
  console.log('GST pricing migration completed');
  await pool.end();
}

migrate().catch(async error => {
  console.error('GST pricing migration failed:', error.message);
  await pool.end();
  process.exit(1);
});
