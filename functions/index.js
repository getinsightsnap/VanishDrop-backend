import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fileRoutes from './routes/files.js';
import userRoutes from './routes/users.js';
import shareRoutes from './routes/share.js';
import adminRoutes from './routes/admin.js';
import analyticsRoutes from './routes/analytics.js';
import { generalLimiter } from './middleware/rateLimiter.js';
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
app.use(express.json());
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

// API Routes
app.use('/api/files', fileRoutes);
app.use('/api/users', userRoutes);
app.use('/api/share', shareRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/analytics', analyticsRoutes);

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
