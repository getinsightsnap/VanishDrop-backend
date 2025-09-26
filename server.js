const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
require('dotenv').config();

// Import all route modules
const publicRouter = require('./routes/public');
const userRouter = require('./routes/user');
const uploadRouter = require('./routes/upload');
const dropsRouter = require('./routes/drops');
const paymentsRouter = require('./routes/payments');
const cleanupRouter = require('./routes/cleanup');
const { scheduleAutoCleanup } = require('./routes/cleanup');

const app = express();
const PORT = process.env.PORT || 3002; // Make sure this is 3002

console.log('🚀 Starting VanishDrop Backend...');

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false
}));

// CORS configuration - CRITICAL for frontend connection
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:5173', 'https://vanishdrop.com'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
}));

// Additional CORS headers for preflight requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  console.log(`📡 ${req.method} ${req.path} from ${req.headers.origin || 'unknown origin'}`);
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

// Logging
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  console.log('✅ Health check accessed');
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    port: PORT
  });
});

// Debug endpoint
app.get('/api/debug', (req, res) => {
  console.log('🔍 Debug endpoint accessed');
  res.json({
    message: 'Backend is running!',
    port: PORT,
    cors: 'enabled',
    timestamp: new Date().toISOString(),
    headers: req.headers
  });
});

// Mount all API routes
app.use('/api', publicRouter);
app.use('/api/user', userRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/drop', dropsRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/cleanup', cleanupRouter);

// Tiers endpoint is handled by public.js router

// 404 handler
app.use('*', (req, res) => {
  console.log(`❌ 404: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ 
    error: 'Endpoint not found',
    path: req.originalUrl,
    method: req.method
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 VanishDrop Backend running on port ${PORT}`);
  console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`✅ Health check: http://localhost:${PORT}/health`);
  console.log(`🔍 Debug endpoint: http://localhost:${PORT}/api/debug`);
  console.log(`📊 Tiers endpoint: http://localhost:${PORT}/api/tiers`);
  
  // Schedule automatic cleanup
  scheduleAutoCleanup();
  console.log('🧹 Automatic cleanup scheduled');
});

module.exports = app;
