require('dotenv').config();

const bcrypt = require('bcryptjs');
const pool = require('../src/config/database');

const createSuperAdmin = async () => {
  try {
    const fullName = 'Kezoi Super Admin';
    const email = 'admin@kezoistays.com';

    const password = process.env.INITIAL_ADMIN_PASSWORD;

    if (!password) {
      throw new Error(
        'INITIAL_ADMIN_PASSWORD is missing in .env'
      );
    }

    const existing = await pool.query(
      `
      SELECT id
      FROM users
      WHERE LOWER(email) = LOWER($1)
      `,
      [email]
    );

    if (existing.rows.length > 0) {
      console.log('Super Admin already exists');
      process.exit(0);
    }

    const passwordHash = await bcrypt.hash(
      password,
      12
    );

    const result = await pool.query(
      `
      INSERT INTO users (
        full_name,
        email,
        password_hash,
        role,
        status
      )
      VALUES ($1, $2, $3, 'SUPER_ADMIN', 'ACTIVE')
      RETURNING id, full_name, email, role
      `,
      [
        fullName,
        email,
        passwordHash
      ]
    );

    console.log(
      'Super Admin created:',
      result.rows[0]
    );

    process.exit(0);

  } catch (error) {
    console.error(
      'Failed to create Super Admin:',
      error
    );

    process.exit(1);
  }
};

createSuperAdmin();