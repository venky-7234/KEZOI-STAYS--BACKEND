const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: process.env.ENV_FILE || '.env' });

/**
 * Checks whether operator confirmation has been explicitly granted.
 * @returns {boolean}
 */
function isConfirmationGranted() {
  return process.argv.includes('--confirm') || process.env.CONFIRM_FOLLOW_UP_MIGRATION === 'YES';
}

/**
 * Returns safe database identity details without exposing credentials.
 * @returns {object}
 */
function getSafeDatabaseTarget() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || '5432',
    database: process.env.DB_NAME || 'kezoi_stays',
    user: process.env.DB_USER || 'postgres'
  };
}

async function runMigration() {
  const target = getSafeDatabaseTarget();

  if (!isConfirmationGranted()) {
    console.error('======================================================================');
    console.error('MIGRATION SAFEGUARD: Accidental Execution Prevented');
    console.error('Target Database:');
    console.error(`  Host:     ${target.host}`);
    console.error(`  Port:     ${target.port}`);
    console.error(`  Database: ${target.database}`);
    console.error(`  User:     ${target.user}`);
    console.error('----------------------------------------------------------------------');
    console.error('Migration 010_whatsapp_message_follow_ups.sql was NOT applied.');
    console.error('To confirm and apply this migration to the target database, run:');
    console.error('  node scripts/migrate-whatsapp-message-follow-up.js --confirm');
    console.error('or set the environment flag:');
    console.error('  CONFIRM_FOLLOW_UP_MIGRATION=YES node scripts/migrate-whatsapp-message-follow-up.js');
    console.error('======================================================================');
    process.exit(1);
  }

  // Defer database connection until explicit confirmation is verified
  const pool = require('../src/config/database');

  console.log(`Applying migration 010 to database "${target.database}" on host "${target.host}"...`);
  const sql = fs.readFileSync(path.resolve(__dirname, '../migrations/010_whatsapp_message_follow_ups.sql'), 'utf8');
  await pool.query(sql);
  console.log('WhatsApp message follow-up migration completed successfully');
  await pool.end();
}

if (require.main === module) {
  runMigration().catch(async error => {
    console.error('WhatsApp message follow-up migration failed:', error.message);
    process.exit(1);
  });
}

module.exports = {
  isConfirmationGranted,
  getSafeDatabaseTarget,
  runMigration
};
