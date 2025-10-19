import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fileRoutes from './routes/files.js';
import userRoutes from './routes/users.js';
import shareRoutes from './routes/share.js';
import adminRoutes from './routes/admin.js';
import analyticsRoutes from './routes/analytics.js';
import webhookRoutes from './routes/webhook.js';
import { generalLimiter, checkoutLimiter } from './middleware/rateLimiter.js';
import { initializeCronJobs } from './jobs/cleanup.js';
import logger from './utils/logger.js';
import { supabaseAdmin } from '../config/supabase.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy - required for Railway and rate limiting
app.set('trust proxy', 1);

// Middleware
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:5175',
  'http://localhost:3000',
  'https://vanishdrop.com',
  'http://vanishdrop.com',
  'https://www.vanishdrop.com',
  'http://www.vanishdrop.com'
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      logger.warn(`CORS blocked request from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// IMPORTANT: Don't parse JSON globally - webhook routes need raw body for signature verification
// Instead, we'll apply express.json() to specific routes that need it
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.http(`${req.method} ${req.url} ${res.statusCode} - ${duration}ms`);
  });
  next();
});

// Apply general rate limiting to all routes
app.use('/api/', generalLimiter);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Simple debug endpoint
app.get('/debug', (req, res) => {
  res.json({ 
    status: 'Debug endpoint working',
    timestamp: new Date().toISOString(),
    message: 'Backend is responding correctly'
  });
});

// Test upload route registration
app.get('/debug/routes', (req, res) => {
  const routes = [];
  const middlewareDebug = [];
  
  app._router.stack.forEach((middleware, index) => {
    middlewareDebug.push({
      index: index,
      name: middleware.name,
      regexp: middleware.regexp ? middleware.regexp.source : 'N/A',
      keys: middleware.keys ? middleware.keys.length : 0
    });
    
    if (middleware.route) {
      routes.push({
        path: middleware.route.path,
        methods: Object.keys(middleware.route.methods)
      });
    } else if (middleware.name === 'router') {
      // Handle mounted routers - check the regexp pattern
      const regexpSource = middleware.regexp.source;
      if (regexpSource.includes('api/files')) {
        routes.push({
          path: '/api/files/*',
          methods: ['POST', 'GET'],
          description: 'File upload routes',
          regexp: regexpSource
        });
      } else if (regexpSource.includes('api/users')) {
        routes.push({
          path: '/api/users/*',
          methods: ['GET', 'POST', 'PUT'],
          description: 'User routes',
          regexp: regexpSource
        });
      } else if (regexpSource.includes('api/share')) {
        routes.push({
          path: '/api/share/*',
          methods: ['GET', 'POST'],
          description: 'Share routes',
          regexp: regexpSource
        });
      } else if (regexpSource.includes('api/admin')) {
        routes.push({
          path: '/api/admin/*',
          methods: ['GET', 'POST'],
          description: 'Admin routes',
          regexp: regexpSource
        });
      } else if (regexpSource.includes('api/analytics')) {
        routes.push({
          path: '/api/analytics/*',
          methods: ['GET'],
          description: 'Analytics routes',
          regexp: regexpSource
        });
      } else {
        // Log any router that doesn't match our expected patterns
        routes.push({
          path: 'UNKNOWN_ROUTER',
          methods: ['UNKNOWN'],
          description: 'Router found but not recognized',
          regexp: regexpSource
        });
      }
    }
  });
  
  res.json({
    status: 'Routes debug',
    routes: routes,
    totalMiddleware: app._router.stack.length,
    middlewareDebug: middlewareDebug.slice(0, 10), // Show first 10 for debugging
    message: 'Available routes listed above'
  });
});

// Test upload endpoint (simplified)
app.post('/debug/upload-test', express.json(), async (req, res) => {
  try {
    res.json({
      status: 'Upload test endpoint working',
      timestamp: new Date().toISOString(),
      message: 'This endpoint works - issue might be in upload middleware or route'
    });
  } catch (err) {
    console.error('Upload test error:', err);
    res.status(500).json({
      error: 'Upload test failed',
      details: err.message
    });
  }
});

// Debug endpoint to test database connection
app.get('/debug/db', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('id, email, subscription_tier, daily_upload_used')
      .limit(5);
    
    if (error) {
      console.error('Database error:', error);
      return res.status(500).json({ 
        error: 'Database connection failed',
        details: error.message,
        code: error.code
      });
    }
    
    res.json({ 
      status: 'Database connected',
      users: data,
      count: data?.length || 0
    });
  } catch (err) {
    console.error('Debug endpoint error:', err);
    res.status(500).json({ 
      error: 'Debug endpoint failed',
      details: err.message
    });
  }
});

// API Routes - Apply JSON parsing to all routes except webhooks
// Webhooks need raw body for signature verification
app.use('/api/files', express.json(), fileRoutes);
app.use('/api/users', express.json(), userRoutes);
app.use('/api/share', express.json(), shareRoutes);
app.use('/api/admin', express.json(), adminRoutes);
app.use('/api/analytics', express.json(), analyticsRoutes);
app.use('/api/webhook', checkoutLimiter, webhookRoutes); // No express.json() - webhook route handles its own body parsing

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error({
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    ip: req.ip
  });
  
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

app.listen(PORT, () => {
  logger.info(`🚀 VanishDrop Backend running on port ${PORT}`);
  logger.info(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`🔐 CORS enabled for: ${process.env.FRONTEND_URL || 'http://localhost:5175'}`);
  
  // Initialize scheduled jobs
  if (process.env.ENABLE_CRON_JOBS !== 'false') {
    initializeCronJobs();
    logger.info('⏰ Scheduled cleanup jobs initialized');
  } else {
    logger.warn('⚠️  Cron jobs disabled via ENABLE_CRON_JOBS env variable');
  }
});
