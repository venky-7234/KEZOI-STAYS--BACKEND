const pool = require('../config/database');

const getPropertyOperationsSummary = async (req, res) => {
  try {
    const { propertyId } = req.params;

    const propertyResult = await pool.query(
      `
      SELECT
        id,
        property_code,
        property_name,
        property_type,
        address,
        area,
        city,
        bedrooms,
        bathrooms,
        max_guests,
        base_price,
        status
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

    const [
      assetSummary,
      photoSummary,
      maintenanceSummary,
      expenseSummary,
      notesSummary,
      recentAssets,
      recentMaintenance,
      recentExpenses,
      recentNotes
    ] = await Promise.all([

      pool.query(
        `
        SELECT
          COUNT(*)::int AS total_asset_records,

          COALESCE(
            SUM(quantity),
            0
          )::int AS total_asset_quantity,

          COALESCE(
            SUM(purchase_price * quantity),
            0
          ) AS total_asset_value

        FROM property_assets

        WHERE property_id = $1
        `,
        [propertyId]
      ),

      pool.query(
        `
        SELECT
          COUNT(*)::int AS total_photos,

          COUNT(*) FILTER (
            WHERE latitude IS NOT NULL
            AND longitude IS NOT NULL
          )::int AS geo_tagged_photos

        FROM asset_photos

        WHERE property_id = $1
        `,
        [propertyId]
      ),

      pool.query(
        `
        SELECT
          COUNT(*)::int AS total_requests,

          COUNT(*) FILTER (
            WHERE maintenance_status = 'OPEN'
          )::int AS open_requests,

          COUNT(*) FILTER (
            WHERE maintenance_status = 'IN_PROGRESS'
          )::int AS in_progress,

          COUNT(*) FILTER (
            WHERE maintenance_status = 'COMPLETED'
          )::int AS completed,

          COALESCE(
            SUM(actual_cost),
            0
          ) AS maintenance_cost

        FROM maintenance_requests

        WHERE property_id = $1
        `,
        [propertyId]
      ),

      pool.query(
        `
        SELECT
          COUNT(*)::int AS total_expense_records,

          COALESCE(
            SUM(amount),
            0
          ) AS total_operational_expenses,

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
          ) AS current_month_expenses

        FROM property_expenses

        WHERE property_id = $1
        `,
        [propertyId]
      ),

      pool.query(
        `
        SELECT
          COUNT(*)::int AS total_notes
        FROM property_notes
        WHERE property_id = $1
        `,
        [propertyId]
      ),

      pool.query(
        `
        SELECT
          id,
          asset_name,
          category,
          room_location,
          quantity,
          purchase_price,
          condition,
          asset_status,
          created_at

        FROM property_assets

        WHERE property_id = $1

        ORDER BY created_at DESC

        LIMIT 5
        `,
        [propertyId]
      ),

      pool.query(
        `
        SELECT
          id,
          title,
          priority,
          maintenance_status,
          estimated_cost,
          actual_cost,
          scheduled_date,
          created_at

        FROM maintenance_requests

        WHERE property_id = $1

        ORDER BY created_at DESC

        LIMIT 5
        `,
        [propertyId]
      ),

      pool.query(
        `
        SELECT
          id,
          category,
          description,
          amount,
          vendor_name,
          expense_date

        FROM property_expenses

        WHERE property_id = $1

        ORDER BY
          expense_date DESC,
          created_at DESC

        LIMIT 5
        `,
        [propertyId]
      ),

      pool.query(
        `
        SELECT
          pn.id,
          pn.note,
          pn.created_at,
          u.full_name AS created_by_name

        FROM property_notes pn

        LEFT JOIN users u
          ON u.id = pn.created_by

        WHERE pn.property_id = $1

        ORDER BY pn.created_at DESC

        LIMIT 5
        `,
        [propertyId]
      )

    ]);

    return res.json({
      success: true,

      property: propertyResult.rows[0],

      summary: {
        assets: {
          ...assetSummary.rows[0],

          total_asset_value:
            Number(
              assetSummary.rows[0]
                .total_asset_value || 0
            )
        },

        photos:
          photoSummary.rows[0],

        maintenance: {
          ...maintenanceSummary.rows[0],

          maintenance_cost:
            Number(
              maintenanceSummary.rows[0]
                .maintenance_cost || 0
            )
        },

        expenses: {
          ...expenseSummary.rows[0],

          total_operational_expenses:
            Number(
              expenseSummary.rows[0]
                .total_operational_expenses || 0
            ),

          current_month_expenses:
            Number(
              expenseSummary.rows[0]
                .current_month_expenses || 0
            )
        },

        notes:
          notesSummary.rows[0]
      },

      recent: {
        assets:
          recentAssets.rows,

        maintenance:
          recentMaintenance.rows,

        expenses:
          recentExpenses.rows.map(
            item => ({
              ...item,
              amount:
                Number(item.amount || 0)
            })
          ),

        notes:
          recentNotes.rows
      }
    });

  } catch (error) {
    console.error(
      'Operations property summary error:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Unable to load property operations summary',
      error: error.message
    });
  }
};


const getOperationsDashboardSummary = async (
  req,
  res
) => {
  try {
    const [
      propertyCount,
      assetCount,
      maintenanceCount,
      expenseTotal,
      photoCount
    ] = await Promise.all([

      pool.query(
        `
        SELECT
          COUNT(*)::int AS total_properties,

          COUNT(*) FILTER (
            WHERE status = 'ACTIVE'
          )::int AS active_properties

        FROM properties
        `
      ),

      pool.query(
        `
        SELECT
          COUNT(*)::int AS total_assets,

          COALESCE(
            SUM(quantity),
            0
          )::int AS total_asset_quantity,

          COALESCE(
            SUM(
              purchase_price * quantity
            ),
            0
          ) AS total_asset_value

        FROM property_assets
        `
      ),

      pool.query(
        `
        SELECT
          COUNT(*)::int AS total_requests,

          COUNT(*) FILTER (
            WHERE maintenance_status = 'OPEN'
          )::int AS open_requests,

          COUNT(*) FILTER (
            WHERE maintenance_status = 'IN_PROGRESS'
          )::int AS in_progress,

          COUNT(*) FILTER (
            WHERE priority = 'HIGH'
            AND maintenance_status != 'COMPLETED'
          )::int AS high_priority_open

        FROM maintenance_requests
        `
      ),

      pool.query(
        `
        SELECT
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
          ) AS current_month_expenses

        FROM property_expenses
        `
      ),

      pool.query(
        `
        SELECT
          COUNT(*)::int AS total_photos,

          COUNT(*) FILTER (
            WHERE latitude IS NOT NULL
            AND longitude IS NOT NULL
          )::int AS geo_tagged_photos

        FROM asset_photos
        `
      )

    ]);

    return res.json({
      success: true,

      summary: {
        properties:
          propertyCount.rows[0],

        assets: {
          ...assetCount.rows[0],

          total_asset_value:
            Number(
              assetCount.rows[0]
                .total_asset_value || 0
            )
        },

        maintenance:
          maintenanceCount.rows[0],

        expenses: {
          total_expenses:
            Number(
              expenseTotal.rows[0]
                .total_expenses || 0
            ),

          current_month_expenses:
            Number(
              expenseTotal.rows[0]
                .current_month_expenses || 0
            )
        },

        photos:
          photoCount.rows[0]
      }
    });

  } catch (error) {
    console.error(
      'Operations dashboard summary error:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Unable to load operations dashboard summary',
      error: error.message
    });
  }
};


module.exports = {
  getPropertyOperationsSummary,
  getOperationsDashboardSummary
};