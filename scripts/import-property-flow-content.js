const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: process.env.ENV_FILE || '.env' });
const pool = require('../src/config/database');
const { imageUrlToMetaBase64 } = require('../src/services/metaImage.service');

async function run() {
  const inputPath = path.resolve(process.argv[2] || '');
  if (!process.argv[2] || !fs.existsSync(inputPath)) throw new Error('Usage: node scripts/import-property-flow-content.js <export.json>');
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  if (!input.property_code || !input.public_description || !input.public_location || !Array.isArray(input.public_amenities) || !Array.isArray(input.gallery)) throw new Error('Export is missing required property content');
  const property = await pool.query('SELECT id,property_code FROM properties WHERE property_code=$1', [input.property_code]);
  if (!property.rows.length) throw new Error(`Property ${input.property_code} was not found`);
  const prepared = [];
  for (const item of input.gallery) {
    console.log(`Preparing gallery image ${Number(item.display_order) + 1}/${input.gallery.length}: ${item.caption || item.alt_text}`);
    prepared.push({ ...item, meta_image_base64: await imageUrlToMetaBase64(item.image_url) });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE properties SET property_name=$1,public_description=$2,public_location=$3,public_amenities=$4::text[],updated_at=NOW() WHERE id=$5`,
      [input.property_name, input.public_description, input.public_location, input.public_amenities, property.rows[0].id]);
    await client.query('DELETE FROM property_marketing_photos WHERE property_id=$1', [property.rows[0].id]);
    for (const item of prepared) await client.query(`INSERT INTO property_marketing_photos(property_id,image_url,meta_image_base64,alt_text,caption,display_order,is_cover,is_active)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [property.rows[0].id, item.image_url, item.meta_image_base64, item.alt_text, item.caption || null, item.display_order, item.is_cover === true, item.is_active !== false]);
    await client.query('COMMIT');
    console.log(`Imported ${prepared.length} gallery images and property content for ${input.property_code}`);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

run().catch(error => { console.error(`Property Flow content import failed: ${error.message}`); process.exitCode = 1; }).finally(() => pool.end());
