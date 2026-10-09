const fs = require('fs');
const path = require('path');
const pool = require('../src/config/database');

async function migrate() {
  const sql = fs.readFileSync(
    path.resolve(__dirname, '../migrations/001_application_form.sql'),
    'utf8'
  );
  await pool.query(sql);
  console.log('Application form migration completed');
  await pool.end();
}

migrate().catch(async error => {
  console.error('Application form migration failed:', error.message);
  await pool.end();
  process.exit(1);
});
