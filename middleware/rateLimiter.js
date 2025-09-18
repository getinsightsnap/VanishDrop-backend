const { RateLimiterRedis, RateLimiterMemory } = require('rate-limiter-flexible');
const { getRedisClient } = require('../config/redis');
const { pool } = require('../config/database');

let rateLimiter;

// Initialize rate limiter
try {
  const redis = getRedisClient();
  rateLimiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: 'rl_',
    points: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100, // Number of requests
    duration: parseInt(process.env.RATE_LIMIT_WINDOW_MS) / 1000 || 900, // Per 15 minutes by default
  });
} catch (error) {
  // Fallback to memory-based rate limiter if Redis is not available
  console.warn('Redis not available for rate limiting, using memory store');
  rateLimiter = new RateLimiterMemory({
    points: 100,
    duration: 900,
  });
}

// General rate limiter middleware
const rateLimitMiddleware = (req, res, next) => {
  const key = req.ip;
  
  rateLimiter.consume(key)
    .then(() => {
      next();
    })
    .catch(() => {
      res.status(429).json({
        error: 'Too many requests',
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfter: Math.round(rateLimiter.msBeforeNext / 1000),
        message: 'Please slow down and try again later'
      });
    });
};

// Check free tier upload limits (5 uploads per IP)
const checkFreeTierLimits = async (req, res, next) => {
  if (req.userTier !== 'free') {
    return next(); // Skip for authenticated users
  }

  try {
    const ip = req.ip;
    const maxUploads = parseInt(process.env.FREE_TIER_LIFETIME_UPLOADS) || 5;

    // Check current usage
    const result = await pool.query(
      'SELECT total_uploads, is_blocked FROM ip_usage WHERE ip_address = $1',
      [ip]
    );

    if (result.rows.length === 0) {
      // First upload from this IP
      await pool.query(
        'INSERT INTO ip_usage (ip_address, total_uploads) VALUES ($1, 0)',
        [ip]
      );
      return next();
    }

    const usage = result.rows[0];

    if (usage.is_blocked) {
      return res.status(403).json({
        error: 'IP address is blocked due to abuse',
        code: 'IP_BLOCKED'
      });
    }

    if (usage.total_uploads >= maxUploads) {
      return res.status(403).json({
        error: `Free tier limit reached. Maximum ${maxUploads} uploads per IP address.`,
        code: 'FREE_TIER_LIMIT_EXCEEDED',
        currentUploads: usage.total_uploads,
        maxUploads: maxUploads,
        tier_limits_reached: true,
        upgradeMessage: 'Upgrade to Pro or Business tier for unlimited uploads'
      });
    }

    // Store usage info in request for later use
    req.ipUsage = usage;
    next();
  } catch (error) {
    console.error('Error checking free tier limits:', error);
    next(); // Continue on error to avoid blocking legitimate users
  }
};

// Increment free tier usage counter
const incrementFreeTierUsage = async (ip) => {
  try {
    await pool.query(`
      INSERT INTO ip_usage (ip_address, total_uploads, last_upload) 
      VALUES ($1, 1, NOW())
      ON CONFLICT (ip_address) 
      DO UPDATE SET 
        total_uploads = ip_usage.total_uploads + 1,
        last_upload = NOW()
    `, [ip]);
  } catch (error) {
    console.error('Error incrementing free tier usage:', error);
  }
};

module.exports = {
  rateLimitMiddleware,
  checkFreeTierLimits,
  incrementFreeTierUsage
};