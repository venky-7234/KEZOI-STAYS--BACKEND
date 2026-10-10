const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
require('dotenv').config();

const pool = require('./src/config/database');

// ======================================================
// ROUTES
// ======================================================

const authRoutes = require('./src/routes/auth.routes');
const guestRoutes = require('./src/routes/guest.routes');
const enquiryRoutes = require('./src/routes/enquiry.routes');
const propertyRoutes = require('./src/routes/property.routes');
const bookingRoutes = require('./src/routes/booking.routes');
require("dotenv").config();
const paymentRoutes =
  require('./src/routes/payment.routes');
  const dashboardRoutes =
  require('./src/routes/dashboard.routes');
  const guestActivityRoutes =
  require('./src/routes/guestActivity.routes');
  const userRoutes =
  require('./src/routes/user.routes');
  const operationsAssetRoutes =
  require('./src/routes/operationsAsset.routes');
  const assetPhotoRoutes =
  require('./src/routes/assetPhoto.routes');
  const servicePartnerRoutes =
  require('./src/routes/servicePartner.routes');

const maintenanceRoutes =
  require('./src/routes/maintenance.routes');
  const propertyExpenseRoutes =
  require('./src/routes/propertyExpense.routes');
  const propertyNoteRoutes =
  require('./src/routes/propertyNote.routes');

const operationsDashboardRoutes =
  require('./src/routes/operationsDashboard.routes');
const billRoutes =
  require('./src/routes/bill.routes');
const applicationRoutes =
  require('./src/routes/application.routes');
const whatsappRoutes =
  require('./src/routes/whatsapp.routes');
const discountOfferRoutes = require('./src/routes/discountOffer.routes');
const integrationRoutes = require('./src/routes/integration.routes');
const metaFlowRoutes = require('./src/routes/metaFlow.routes');


// ======================================================
// APP
// ======================================================

const app = express();


// ======================================================
// GLOBAL MIDDLEWARE
// MUST COME BEFORE ALL ROUTES
// ======================================================

app.use(helmet());

app.use(
  cors({
    origin: true,
    credentials: true
  })
);

app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(morgan('dev'));


// ======================================================
// HEALTH CHECK
// ======================================================

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Kezoi Stays backend is running'
  });
});


// ======================================================
// DATABASE TEST
// ======================================================

app.get('/api/db-test', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT NOW()'
    );

    return res.json({
      success: true,
      databaseTime: result.rows[0].now
    });

  } catch (error) {
    console.error(
      'Database test error:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Database connection failed',
      error: error.message
    });
  }
});


// ======================================================
// API ROUTES
// IMPORTANT: ALL COME AFTER express.json()
// ======================================================

app.use(
  '/api/auth',
  authRoutes
);

app.use(
  '/api/guests',
  guestRoutes
);

app.use(
  '/api/enquiries',
  enquiryRoutes
);

app.use(
  '/api/properties',
  propertyRoutes
);

app.use(
  '/api/bookings',
  bookingRoutes
);

app.use('/api/discount-offers', discountOfferRoutes);
app.use('/api/integrations', integrationRoutes);
app.use('/api/meta/flows', metaFlowRoutes);

app.use(
  '/api/payments',
  paymentRoutes
);

app.use(
  '/api/dashboard',
  dashboardRoutes
);

app.use(
  '/api/guest-activity',
  guestActivityRoutes
);

app.use(
  '/api/users',
  userRoutes
);

app.use(
  '/api/operations/assets',
  operationsAssetRoutes
);

app.use(
  '/api/operations/photos',
  assetPhotoRoutes
);

app.use(
  '/api/operations/service-partners',
  servicePartnerRoutes
);

app.use(
  '/api/operations/maintenance',
  maintenanceRoutes
);

app.use(
  '/api/operations/expenses',
  propertyExpenseRoutes
);

app.use(
  '/api/operations/notes',
  propertyNoteRoutes
);

app.use(
  '/api/operations/dashboard',
  operationsDashboardRoutes
);

app.use(
  '/api/bills',
  billRoutes
);

app.use(
  '/api/applications',
  applicationRoutes
);

app.use(
  '/api/test/whatsapp',
  whatsappRoutes
);
// ======================================================
// 404
// ======================================================

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message:
      `Route not found: ${req.method} ${req.originalUrl}`
  });
});


// ======================================================
// GLOBAL ERROR HANDLER
// ======================================================

app.use(
  (error, req, res, next) => {
    console.error(
      'Unhandled backend error:',
      error
    );

    return res.status(500).json({
      success: false,
      message:
        'Internal server error'
    });
  }
);


// ======================================================
// START SERVER
// ======================================================

const PORT =
  process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(
    `Kezoi Stays backend running on http://localhost:${PORT}`
  );
});
