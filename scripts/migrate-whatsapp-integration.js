const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: process.env.ENV_FILE || '.env' });
const pool = require('../src/config/database');

async function migrate() {
  const sql = fs.readFileSync(path.resolve(__dirname, '../migrations/006_whatsapp_integration.sql'), 'utf8');
  await pool.query(sql);
  console.log('WhatsApp integration migration completed');
  await pool.end();
}

migrate().catch(async error => {
  console.error('WhatsApp integration migration failed:', error.message);
  await pool.end();
  process.exit(1);
});
