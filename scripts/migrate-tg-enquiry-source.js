const fs = require('fs');
const path = require('path');
const pool = require('../src/config/database');

async function migrate() {
  const sql = fs.readFileSync(
    path.resolve(__dirname, '../migrations/002_add_tg_enquiry_source.sql'),
    'utf8'
  );
  await pool.query(sql);
  const verification = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
      WHERE conrelid = 'enquiries'::regclass
        AND conname = 'enquiries_source_check'`
  );
  if (!verification.rows[0]?.definition.includes('TG-0001')) {
    throw new Error('TG-0001 was not added to enquiries_source_check');
  }
  console.log('TG-0001 enquiry source migration completed');
  await pool.end();
}

migrate().catch(async error => {
  console.error('TG-0001 enquiry source migration failed:', error.message);
  await pool.end();
  process.exit(1);
});
