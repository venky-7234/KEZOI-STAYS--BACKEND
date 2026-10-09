const fs = require('fs');
const path = require('path');
const pool = require('../src/config/database');

async function migrate() {
  const sql = fs.readFileSync(
    path.resolve(__dirname, '../migrations/003_discounts_and_referrals.sql'),
    'utf8'
  );
  await pool.query(sql);
  console.log('Discounts and referrals migration completed');
  await pool.end();
}

migrate().catch(async error => {
  console.error('Discounts and referrals migration failed:', error.message);
  await pool.end();
  process.exit(1);
});
