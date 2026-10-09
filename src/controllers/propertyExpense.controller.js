const pool = require('../config/database');


// ======================================================
// CREATE PROPERTY EXPENSE
// ======================================================

const createPropertyExpense = async (req, res) => {
  try {
    const {
      property_id,
      category,
      description,
      amount,
      vendor_name,
      expense_date,
      receipt_url,
      notes
    } = req.body;

    if (!property_id || !category || !amount || !expense_date) {
      return res.status(400).json({
        success: false,
        message:
          'property_id, category, amount and expense_date are required'
      });
    }

    const propertyResult = await pool.query(
      `
      SELECT id
      FROM properties
      WHERE id = $1
      `,
      [property_id]
    );

    if (propertyResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    const numericAmount = Number(amount);

    if (
      Number.isNaN(numericAmount) ||
      numericAmount <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be greater than 0'
      });
    }

    const result = await pool.query(
      `
      INSERT INTO property_expenses (
        property_id,
        category,
        description,
        amount,
        vendor_name,
        expense_date,
        receipt_url,
        notes,
        created_by
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9
      )
      RETURNING *
      `,
      [
        property_id,
        String(category).toUpperCase(),
        description || null,
        numericAmount,
        vendor_name || null,
        expense_date,
        receipt_url || null,
        notes || null,
        req.user.id
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Property expense recorded successfully',
      expense: result.rows[0]
    });

  } catch (error) {
    console.error('Create property expense error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to create property expense',
      error: error.message
    });
  }
};


// ======================================================
// GET PROPERTY EXPENSES
// ======================================================

const getPropertyExpenses = async (req, res) => {
  try {
    const {
      property_id,
      category,
      start_date,
      end_date,
      search
    } = req.query;

    const values = [];
    const conditions = [];

    if (property_id) {
      values.push(property_id);

      conditions.push(
        `e.property_id = $${values.length}`
      );
    }

    if (category) {
      values.push(String(category).toUpperCase());

      conditions.push(
        `e.category = $${values.length}`
      );
    }

    if (start_date) {
      values.push(start_date);

      conditions.push(
        `e.expense_date >= $${values.length}`
      );
    }

    if (end_date) {
      values.push(end_date);

      conditions.push(
        `e.expense_date <= $${values.length}`
      );
    }

    if (search) {
      values.push(
        `%${String(search).toLowerCase()}%`
      );

      conditions.push(`
        (
          LOWER(
            COALESCE(e.description, '')
          ) LIKE $${values.length}

          OR LOWER(
            COALESCE(e.vendor_name, '')
          ) LIKE $${values.length}

          OR LOWER(
            COALESCE(e.notes, '')
          ) LIKE $${values.length}
        )
      `);
    }

    const whereClause =
      conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : '';

    const result = await pool.query(
      `
      SELECT
        e.*,

        p.property_code,
        p.property_name,

        u.full_name AS created_by_name

      FROM property_expenses e

      JOIN properties p
        ON p.id = e.property_id

      LEFT JOIN users u
        ON u.id = e.created_by

      ${whereClause}

      ORDER BY
        e.expense_date DESC,
        e.created_at DESC
      `,
      values
    );

    return res.json({
      success: true,
      total: result.rows.length,
      expenses: result.rows
    });

  } catch (error) {
    console.error('Get property expenses error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to load property expenses',
      error: error.message
    });
  }
};


// ======================================================
// GET EXPENSE BY ID
// ======================================================

const getPropertyExpenseById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      SELECT
        e.*,

        p.property_code,
        p.property_name,

        u.full_name AS created_by_name

      FROM property_expenses e

      JOIN properties p
        ON p.id = e.property_id

      LEFT JOIN users u
        ON u.id = e.created_by

      WHERE e.id = $1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Expense not found'
      });
    }

    return res.json({
      success: true,
      expense: result.rows[0]
    });

  } catch (error) {
    console.error('Get property expense error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to load property expense',
      error: error.message
    });
  }
};


// ======================================================
// UPDATE PROPERTY EXPENSE
// ======================================================

const updatePropertyExpense = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      category,
      description,
      amount,
      vendor_name,
      expense_date,
      receipt_url,
      notes
    } = req.body;

    if (
      amount !== undefined &&
      Number(amount) <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be greater than 0'
      });
    }

    const result = await pool.query(
      `
      UPDATE property_expenses
      SET
        category =
          COALESCE($1, category),

        description =
          COALESCE($2, description),

        amount =
          COALESCE($3, amount),

        vendor_name =
          COALESCE($4, vendor_name),

        expense_date =
          COALESCE($5, expense_date),

        receipt_url =
          COALESCE($6, receipt_url),

        notes =
          COALESCE($7, notes),

        updated_at =
          CURRENT_TIMESTAMP

      WHERE id = $8

      RETURNING *
      `,
      [
        category
          ? String(category).toUpperCase()
          : null,
        description ?? null,
        amount ?? null,
        vendor_name ?? null,
        expense_date || null,
        receipt_url ?? null,
        notes ?? null,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Expense not found'
      });
    }

    return res.json({
      success: true,
      message: 'Property expense updated successfully',
      expense: result.rows[0]
    });

  } catch (error) {
    console.error('Update property expense error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to update property expense',
      error: error.message
    });
  }
};


// ======================================================
// PROPERTY EXPENSE SUMMARY
// ======================================================

const getPropertyExpenseSummary = async (req, res) => {
  try {
    const { propertyId } = req.params;

    const propertyResult = await pool.query(
      `
      SELECT
        id,
        property_code,
        property_name
      FROM properties
      WHERE id = $1
      `,
      [propertyId]
    );

    if (propertyResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Property not found'
      });
    }

    const summaryResult = await pool.query(
      `
      SELECT

        COUNT(*)::int
          AS total_expense_records,

        COALESCE(
          SUM(amount),
          0
        ) AS total_expenses,

        COALESCE(
          SUM(amount)
          FILTER (
            WHERE expense_date >=
              DATE_TRUNC(
                'month',
                CURRENT_DATE
              )
          ),
          0
        ) AS current_month_expenses,

        COALESCE(
          SUM(amount)
          FILTER (
            WHERE expense_date =
              CURRENT_DATE
          ),
          0
        ) AS today_expenses

      FROM property_expenses

      WHERE property_id = $1
      `,
      [propertyId]
    );

    const categoryResult = await pool.query(
      `
      SELECT

        category,

        COUNT(*)::int
          AS expense_count,

        COALESCE(
          SUM(amount),
          0
        ) AS total_amount

      FROM property_expenses

      WHERE property_id = $1

      GROUP BY category

      ORDER BY total_amount DESC
      `,
      [propertyId]
    );

    return res.json({
      success: true,

      property:
        propertyResult.rows[0],

      summary: {
        ...summaryResult.rows[0],

        total_expenses:
          Number(
            summaryResult.rows[0]
              .total_expenses || 0
          ),

        current_month_expenses:
          Number(
            summaryResult.rows[0]
              .current_month_expenses || 0
          ),

        today_expenses:
          Number(
            summaryResult.rows[0]
              .today_expenses || 0
          )
      },

      categories:
        categoryResult.rows.map(
          (row) => ({
            ...row,
            total_amount:
              Number(row.total_amount || 0)
          })
        )
    });

  } catch (error) {
    console.error(
      'Property expense summary error:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Unable to load property expense summary',
      error: error.message
    });
  }
};


// ======================================================
// DELETE EXPENSE
// ======================================================

const deletePropertyExpense = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `
      DELETE FROM property_expenses
      WHERE id = $1
      RETURNING *
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Expense not found'
      });
    }

    return res.json({
      success: true,
      message: 'Property expense deleted successfully'
    });

  } catch (error) {
    console.error('Delete property expense error:', error);

    return res.status(500).json({
      success: false,
      message: 'Unable to delete property expense',
      error: error.message
    });
  }
};


module.exports = {
  createPropertyExpense,
  getPropertyExpenses,
  getPropertyExpenseById,
  updatePropertyExpense,
  getPropertyExpenseSummary,
  deletePropertyExpense
};