const getTierLimits = (tier) => {
  const limits = {
    free: {
      maxFileSize: 50 * 1024 * 1024, // 50MB
      lifetimeUploads: 5, // 5 uploads total per IP
      minExpiration: 1 * 60 * 1000, // 1 minute
      maxExpiration: 10 * 60 * 1000, // 10 minutes
      features: ['basic_sharing', 'qr_generation'],
      allowPassword: false,
      allowQR: true,
      allowOTP: false,
      allowWebhooks: false,
      allowAnalytics: false,
      allowRequestPortals: false,
      allowAPIKeys: false
    },
    pro: {
      maxFileSize: 10 * 1024 * 1024 * 1024, // 10GB
      lifetimeUploads: -1, // unlimited
      minExpiration: 1 * 60 * 1000, // 1 minute
      maxExpiration: 60 * 60 * 1000, // 60 minutes
      maxAccessCount: 100, // 1-100 times link can be opened
      minAccessCount: 1,
      features: ['basic_sharing', 'password_protection', 'otp_protection', 'qr_generation', 'dashboard', 'email_notifications'],
      allowPassword: true,
      allowQR: true,
      allowOTP: true,
      allowWebhooks: false,
      allowAnalytics: true,
      allowRequestPortals: false,
      allowAPIKeys: false
    },
    business: {
      maxFileSize: 10 * 1024 * 1024 * 1024, // 10GB
      lifetimeUploads: -1, // unlimited
      minExpiration: 1 * 60 * 1000, // 1 minute
      maxExpiration: 60 * 60 * 1000, // 60 minutes
      maxAccessCount: 100, // 1-100 times link can be opened
      minAccessCount: 1,
      features: ['all_features', 'password_protection', 'otp_protection', 'qr_generation', 'request_portals', 'webhooks', 'api_access', 'analytics'],
      allowPassword: true,
      allowQR: true,
      allowOTP: true,
      allowWebhooks: true,
      allowAnalytics: true,
      allowRequestPortals: true,
      allowAPIKeys: true
    }
  };
  
  return limits[tier] || limits.free;
};

const validateTierLimits = (req, options = {}) => {
  const limits = req.tierLimits;
  const errors = [];

  // Check file size
  if (req.file && req.file.size > limits.maxFileSize) {
    errors.push({
      field: 'file',
      message: `File size ${(req.file.size / 1024 / 1024).toFixed(1)}MB exceeds ${(limits.maxFileSize / 1024 / 1024).toFixed(1)}MB limit for ${req.userTier} tier`,
      code: 'FILE_TOO_LARGE'
    });
  }

  // Check expiration time
  if (options.expiration) {
    const expirationMs = parseInt(options.expiration) * 60 * 1000; // Convert minutes to ms
    if (expirationMs < limits.minExpiration || expirationMs > limits.maxExpiration) {
      errors.push({
        field: 'expiration',
        message: `Expiration time must be between ${limits.minExpiration / 60 / 1000} and ${limits.maxExpiration / 60 / 1000} minutes for ${req.userTier} tier`,
        code: 'INVALID_EXPIRATION'
      });
    }
  }

  // Check password protection
  if (options.password && !limits.allowPassword) {
    errors.push({
      field: 'password',
      message: `Password protection is only available for Pro and Business tiers`,
      code: 'FEATURE_RESTRICTED',
      feature_restricted: true,
      upgradeRequired: true
    });
  }

  // Check OTP protection  
  if (options.otp && !limits.allowOTP) {
    errors.push({
      field: 'otp',
      message: `OTP protection is only available for Pro and Business tiers`,
      code: 'FEATURE_RESTRICTED',
      feature_restricted: true,
      upgradeRequired: true
    });
  }

  // Check webhooks
  if (options.webhook && !limits.allowWebhooks) {
    errors.push({
      field: 'webhook',
      message: `Webhooks are only available for Business tier`,
      code: 'FEATURE_RESTRICTED',
      feature_restricted: true,
      upgradeRequired: true
    });
  }

  // Check access count limits
  if (options.accessCount) {
    const accessCount = parseInt(options.accessCount);
    if (accessCount < limits.minAccessCount || accessCount > limits.maxAccessCount) {
      errors.push({
        field: 'accessCount',
        message: `Access count must be between ${limits.minAccessCount} and ${limits.maxAccessCount} for ${req.userTier} tier`,
        code: 'INVALID_ACCESS_COUNT'
      });
    }
  }

  return errors;
};

module.exports = {
  getTierLimits,
  validateTierLimits
};
