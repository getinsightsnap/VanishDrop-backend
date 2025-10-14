import { body, param, query, validationResult } from 'express-validator';

// Middleware to handle validation errors
export const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      error: 'Validation failed', 
      details: errors.array() 
    });
  }
  next();
};

// File upload validation
export const validateFileUpload = [
  body('expires_in_hours')
    .optional()
    .isInt({ min: 1, max: 168 })
    .withMessage('Expiration must be between 1 and 168 hours (7 days)'),
  handleValidationErrors
];

// Share link creation validation
export const validateShareLink = [
  body('file_id')
    .notEmpty()
    .withMessage('File ID is required')
    .isUUID()
    .withMessage('File ID must be a valid UUID'),
  body('expires_at')
    .notEmpty()
    .withMessage('Expiration date is required')
    .isISO8601()
    .withMessage('Expiration date must be a valid ISO 8601 date'),
  body('max_opens')
    .optional()
    .isInt({ min: 1, max: 10000 })
    .withMessage('Max opens must be between 1 and 10000'),
  body('password')
    .optional()
    .isString()
    .isLength({ min: 4, max: 100 })
    .withMessage('Password must be between 4 and 100 characters'),
  body('require_otp')
    .optional()
    .isBoolean()
    .withMessage('require_otp must be a boolean'),
  body('qr_code_enabled')
    .optional()
    .isBoolean()
    .withMessage('qr_code_enabled must be a boolean'),
  handleValidationErrors
];

// Share link access validation
export const validateShareAccess = [
  param('token')
    .notEmpty()
    .withMessage('Token is required')
    .isString()
    .isLength({ min: 10, max: 50 })
    .withMessage('Invalid token format'),
  body('password')
    .optional()
    .isString()
    .isLength({ min: 1, max: 100 })
    .withMessage('Password must be between 1 and 100 characters'),
  body('ip_address')
    .optional()
    .isString()
    .isLength({ max: 45 })
    .withMessage('Invalid IP address format'),
  handleValidationErrors
];

// Password verification validation
export const validatePassword = [
  param('token')
    .notEmpty()
    .withMessage('Token is required')
    .isString(),
  body('password')
    .notEmpty()
    .withMessage('Password is required')
    .isString()
    .isLength({ min: 1, max: 100 })
    .withMessage('Password must be between 1 and 100 characters'),
  handleValidationErrors
];

// User subscription update validation
export const validateSubscriptionUpdate = [
  body('subscription_tier')
    .notEmpty()
    .withMessage('Subscription tier is required')
    .isIn(['free', 'pro'])
    .withMessage('Subscription tier must be either "free" or "pro"'),
  handleValidationErrors
];

// UUID parameter validation
export const validateUUID = [
  param('fileId')
    .optional()
    .isUUID()
    .withMessage('Invalid file ID format'),
  param('linkId')
    .optional()
    .isUUID()
    .withMessage('Invalid link ID format'),
  handleValidationErrors
];

// Email validation
export const validateEmail = [
  body('email')
    .notEmpty()
    .withMessage('Email is required')
    .isEmail()
    .withMessage('Must be a valid email address')
    .normalizeEmail(),
  handleValidationErrors
];

// OTP validation
export const validateOTP = [
  body('otp')
    .notEmpty()
    .withMessage('OTP is required')
    .isNumeric()
    .withMessage('OTP must be numeric')
    .isLength({ min: 6, max: 6 })
    .withMessage('OTP must be 6 digits'),
  handleValidationErrors
];

export default {
  handleValidationErrors,
  validateFileUpload,
  validateShareLink,
  validateShareAccess,
  validatePassword,
  validateSubscriptionUpdate,
  validateUUID,
  validateEmail,
  validateOTP,
};

