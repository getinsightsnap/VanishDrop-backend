import rateLimit from 'express-rate-limit';

// General API rate limiter
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests',
    message: 'Too many requests from this IP, please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests',
      message: 'Too many requests from this IP, please try again later.',
      retryAfter: '15 minutes'
    });
  }
});

// Stricter rate limiter for authentication endpoints
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 login/signup attempts per windowMs
  message: 'Too many authentication attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false, // Count all requests
});

// Rate limiter for file uploads
export const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50, // Limit each IP to 50 uploads per hour
  message: 'Upload limit reached, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for share link access (prevent abuse)
export const shareLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 20, // Limit each IP to 20 share link accesses per 5 minutes
  message: 'Too many download attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for password verification attempts
export const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 password attempts per 15 minutes
  message: 'Too many password attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for checkout endpoints (more lenient for testing)
export const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // Limit each IP to 200 checkout requests per 15 minutes
  message: {
    error: 'Too many checkout requests',
    message: 'Too many checkout requests from this IP, please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many checkout requests',
      message: 'Too many checkout requests from this IP, please try again later.',
      retryAfter: '15 minutes'
    });
  }
});

export default {
  generalLimiter,
  authLimiter,
  uploadLimiter,
  shareLimiter,
  passwordLimiter,
  checkoutLimiter,
};

