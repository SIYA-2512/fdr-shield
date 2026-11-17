require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const { connectDB, pool, query } = require('./src/config/db');
const bcrypt = require('bcryptjs');
const errorHandler = require('./src/middleware/errorHandler');
const { alertCronJob } = require('./src/jobs/alertCron');

const app = express();

// 1. Security & Core Middleware
app.use(helmet());

// Dynamic CORS configuration allowing localhost, Render frontend, and custom client URLs
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://fdr-shield.onrender.com',
  process.env.CLIENT_URL,
].filter(Boolean);

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      const isAllowed =
        allowedOrigins.includes(origin) ||
        origin.endsWith('.onrender.com') ||
        origin.startsWith('http://localhost:');
      if (isAllowed) {
        return callback(null, true);
      }
      return callback(null, true); // Allow all origins for hackathon deployment
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// 2. Global Rate Limiting (150 requests per 15 minutes per IP)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again after 15 minutes.',
  },
});
app.use('/api', apiLimiter);

// Database schema auto-initialization helper
const runDatabaseMigrations = async () => {
  const sqlFilePath = path.join(__dirname, 'database.sql');
  if (!fs.existsSync(sqlFilePath)) {
    throw new Error('database.sql file not found');
  }
  const sql = fs.readFileSync(sqlFilePath, 'utf8');
  await query(sql);
  const freshHash = await bcrypt.hash('Admin@123', 10);
  const updateRes = await query('UPDATE users SET password_hash = $1', [freshHash]);
  return updateRes.rowCount;
};

// 3. Health Check & Database Setup Endpoints
app.get(['/api/health', '/health'], (req, res) => {
  res.status(200).json({
    success: true,
    service: 'AICTE FDR Shield API',
    status: 'OPERATIONAL',
    timestamp: new Date().toISOString(),
  });
});

app.all(['/api/setup-db', '/setup-db'], async (req, res) => {
  try {
    const updatedCount = await runDatabaseMigrations();
    res.status(200).json({
      success: true,
      message: `Database schema and initial seed data applied successfully. Updated ${updatedCount} users with password Admin@123.`,
    });
  } catch (err) {
    console.error('[DB SETUP ERROR]:', err);
    res.status(500).json({
      success: false,
      message: `Database setup failed: ${err.message}`,
      detail: err.detail || null,
    });
  }
});

// 4. Mount All API Routes at /api and also at / for universal base URL compatibility
const routeBindings = [
  { prefix: '/api/auth', file: './src/routes/authRoutes.js' },
  { prefix: '/api/institutions', file: './src/routes/institutionRoutes.js' },
  { prefix: '/api/fdrs', file: './src/routes/fdrRoutes.js' },
  { prefix: '/api/documents', file: './src/routes/documentRoutes.js' },
  { prefix: '/api/release-requests', file: './src/routes/releaseRoutes.js' },
  { prefix: '/api/alerts', file: './src/routes/alertRoutes.js' },
  { prefix: '/api/notifications', file: './src/routes/notificationRoutes.js' },
  { prefix: '/api/dashboard', file: './src/routes/dashboardRoutes.js' },
  { prefix: '/api/audit', file: './src/routes/auditRoutes.js' },
];

routeBindings.forEach(({ prefix, file }) => {
  const fullPath = path.resolve(__dirname, file);
  if (fs.existsSync(fullPath)) {
    const router = require(file);
    app.use(prefix, router);
    const nonApiPrefix = prefix.replace(/^\/api/, '');
    if (nonApiPrefix) {
      app.use(nonApiPrefix, router);
    }
    console.log(`[ROUTE] Mounted ${prefix} & ${nonApiPrefix} -> ${file}`);
  } else {
    const notImplementedHandler = (req, res) => {
      res.status(501).json({
        success: false,
        message: `Route module ${file} not initialized yet.`,
      });
    };
    app.use(prefix, notImplementedHandler);
    const nonApiPrefix = prefix.replace(/^\/api/, '');
    if (nonApiPrefix) {
      app.use(nonApiPrefix, notImplementedHandler);
    }
  }
});

// 5. 404 Catch-All Handler
app.use((req, res, next) => {
  const error = new Error(`Route not found - ${req.originalUrl}`);
  error.statusCode = 404;
  next(error);
});

// 6. Global Error Handler
app.use(errorHandler);

// 7. Start Server, Test Database Connection, and Initialize Cron
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  await connectDB();

  // Auto-initialize tables and seed data if users table does not exist
  try {
    const tableCheck = await query("SELECT to_regclass('public.users') AS exists;");
    if (!tableCheck.rows[0].exists) {
      console.log('[DB] "users" table not found. Auto-running schema and seed data...');
      const updatedCount = await runDatabaseMigrations();
      console.log(`[DB] ✅ Schema and seed data applied. Initialized ${updatedCount} users.`);
    } else {
      console.log('[DB] ✅ Database tables verified.');
    }
  } catch (dbInitErr) {
    console.error('[DB] Schema verification/migration warning:', dbInitErr.message);
  }

  // Start the background cron job (Daily at 9:00 AM IST)
  alertCronJob.start();
  console.log('[CRON] AICTE FDR Maturity Alert cron scheduler initiated (0 9 * * *).');

  app.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(`🛡️  FDR Shield Backend running on port ${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`=================================================`);
  });
};

startServer();

module.exports = app;
