const bcrypt = require('bcryptjs');
const pool = require('../config/database');

const allowedRoles = [
  'SUPER_ADMIN',
  'ADMIN',
  'OPERATIONS',
  'STAFF'
];

const allowedStatuses = [
  'ACTIVE',
  'INACTIVE',
  'BLOCKED'
];

const MAX_SUPER_ADMINS = 2;

const hasReachedSuperAdminLimit = async () => {
  const result = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM users
    WHERE role = 'SUPER_ADMIN'
  `);

  return result.rows[0].count >= MAX_SUPER_ADMINS;
};


// ======================================================
// GET ALL USERS
// ======================================================

const getUsers = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        full_name,
        email,
        phone,
        role,
        status,
        created_at,
        updated_at
      FROM users
      ORDER BY created_at DESC
      `
    );

    return res.json({
      success: true,
      total: result.rows.length,
      users: result.rows
    });

  } catch (error) {
    console.error('Get users error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to load users',
      error: error.message
    });
  }
};


// ======================================================
// GET USER BY ID
// ======================================================

const getUserById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT
        id,
        full_name,
        email,
        phone,
        role,
        status,
        created_at,
        updated_at
      FROM users
      WHERE id = $1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    return res.json({
      success: true,
      user: result.rows[0]
    });

  } catch (error) {
    console.error('Get user error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to load user',
      error: error.message
    });
  }
};


// ======================================================
// CREATE USER
// ======================================================

const createUser = async (req, res) => {
  try {
    const {
      full_name,
      email,
      phone,
      password,
      role = 'STAFF'
    } = req.body;

    if (!full_name || !email || !password) {
      return res.status(400).json({
        success: false,
        message:
          'Full name, email and password are required'
      });
    }

    if (String(password).length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters'
      });
    }

    const normalizedEmail =
      email.trim().toLowerCase();

    const normalizedRole =
      String(role).toUpperCase();

    if (!allowedRoles.includes(normalizedRole)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user role'
      });
    }

    if (
      normalizedRole === 'SUPER_ADMIN' &&
      await hasReachedSuperAdminLimit()
    ) {
      return res.status(409).json({
        success: false,
        message: `Only ${MAX_SUPER_ADMINS} super admins are allowed`
      });
    }

    const existing = await pool.query(
      `
      SELECT id
      FROM users
      WHERE LOWER(email) = $1
      `,
      [normalizedEmail]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'User already exists'
      });
    }

    const passwordHash =
      await bcrypt.hash(password, 12);

    const result = await pool.query(
      `
      INSERT INTO users (
        full_name,
        email,
        phone,
        password_hash,
        role,
        status
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        'ACTIVE'
      )
      RETURNING
        id,
        full_name,
        email,
        phone,
        role,
        status,
        created_at
      `,
      [
        full_name.trim(),
        normalizedEmail,
        phone || null,
        passwordHash,
        normalizedRole
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'User created successfully',
      user: result.rows[0]
    });

  } catch (error) {
    console.error('Create user error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to create user',
      error: error.message
    });
  }
};


// ======================================================
// UPDATE USER
// ======================================================

const updateUser = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      full_name,
      email,
      phone,
      role,
      status
    } = req.body;

    let normalizedRole = null;
    let normalizedStatus = null;

    if (role) {
      normalizedRole =
        String(role).toUpperCase();

      if (!allowedRoles.includes(normalizedRole)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user role'
        });
      }

      if (normalizedRole === 'SUPER_ADMIN') {
        const currentUser = await pool.query(
          'SELECT role FROM users WHERE id = $1',
          [id]
        );

        if (currentUser.rows.length === 0) {
          return res.status(404).json({
            success: false,
            message: 'User not found'
          });
        }

        if (
          currentUser.rows[0].role !== 'SUPER_ADMIN' &&
          await hasReachedSuperAdminLimit()
        ) {
          return res.status(409).json({
            success: false,
            message: `Only ${MAX_SUPER_ADMINS} super admins are allowed`
          });
        }
      }
    }

    if (status) {
      normalizedStatus =
        String(status).toUpperCase();

      if (!allowedStatuses.includes(normalizedStatus)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid user status'
        });
      }
    }

    const normalizedEmail =
      email
        ? email.trim().toLowerCase()
        : null;

    const result = await pool.query(
      `
      UPDATE users
      SET
        full_name = COALESCE($1, full_name),
        email = COALESCE($2, email),
        phone = COALESCE($3, phone),
        role = COALESCE($4, role),
        status = COALESCE($5, status),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING
        id,
        full_name,
        email,
        phone,
        role,
        status,
        created_at,
        updated_at
      `,
      [
        full_name || null,
        normalizedEmail,
        phone || null,
        normalizedRole,
        normalizedStatus,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    return res.json({
      success: true,
      message: 'User updated successfully',
      user: result.rows[0]
    });

  } catch (error) {
    console.error('Update user error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to update user',
      error: error.message
    });
  }
};


// ======================================================
// RESET USER PASSWORD
// ======================================================

const resetUserPassword = async (req, res) => {
  try {
    const { id } = req.params;

    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        success: false,
        message: 'New password is required'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message:
          'Password must be at least 8 characters'
      });
    }

    const passwordHash =
      await bcrypt.hash(password, 12);

    const result = await pool.query(
      `
      UPDATE users
      SET
        password_hash = $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING id
      `,
      [
        passwordHash,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    return res.json({
      success: true,
      message:
        'User password reset successfully'
    });

  } catch (error) {
    console.error(
      'Reset password error:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Unable to reset password',
      error: error.message
    });
  }
};


// ======================================================
// DELETE STAFF MEMBER
// ======================================================

const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    if (!/^\d+$/.test(String(id))) {
      return res.status(400).json({
        success: false,
        message: 'Invalid user ID'
      });
    }

    const existing = await pool.query(
      'SELECT id, full_name, role FROM users WHERE id = $1::bigint',
      [id]
    );

    if (!existing.rows.length) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const user = existing.rows[0];
    if (user.role === 'SUPER_ADMIN') {
      return res.status(403).json({
        success: false,
        message: 'Super admin accounts cannot be deleted'
      });
    }

    const result = await pool.query(
      `DELETE FROM users
        WHERE id = $1::bigint AND role <> 'SUPER_ADMIN'
        RETURNING id, full_name, email, role`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(409).json({
        success: false,
        message: 'The user role changed and the account was not deleted'
      });
    }

    return res.json({
      success: true,
      message: 'Staff member deleted successfully',
      user: result.rows[0]
    });
  } catch (error) {
    if (error.code === '23503') {
      return res.status(409).json({
        success: false,
        message: 'This staff member has linked records and cannot be deleted. Set the account status to BLOCKED instead.'
      });
    }

    console.error('Delete user error:', error);
    return res.status(500).json({
      success: false,
      message: 'Unable to delete staff member',
      error: error.message
    });
  }
};


module.exports = {
  getUsers,
  getUserById,
  createUser,
  updateUser,
  resetUserPassword,
  deleteUser
};
