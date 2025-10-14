import winston from 'winston';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Define colors for each level
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'white',
};

winston.addColors(colors);

// Define log format
const format = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(
    (info) => `${info.timestamp} ${info.level}: ${info.message}`,
  ),
);

// Define which transports the logger should use
const transports = [
  // Console transport
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }),
];

// Add file transports in production
if (process.env.NODE_ENV === 'production') {
  // Error log file
  transports.push(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    })
  );

  // Combined log file
  transports.push(
    new winston.transports.File({
      filename: 'logs/combined.log',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      ),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    })
  );
}

// Create the logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  levels,
  format,
  transports,
});

// Create a stream object for Morgan
logger.stream = {
  write: (message) => logger.http(message.trim())
};

// Helper functions for structured logging
export const logRequest = (req, res, duration) => {
  logger.http({
    method: req.method,
    url: req.url,
    status: res.statusCode,
    duration: `${duration}ms`,
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
};

export const logFileUpload = (userId, filename, fileSize, success) => {
  logger.info({
    event: 'file_upload',
    userId,
    filename,
    fileSize,
    success,
    timestamp: new Date().toISOString()
  });
};

export const logShareLinkCreated = (userId, shareToken, hasPassword, requireOtp) => {
  logger.info({
    event: 'share_link_created',
    userId,
    shareToken,
    hasPassword,
    requireOtp,
    timestamp: new Date().toISOString()
  });
};

export const logFileAccess = (shareToken, ipAddress, success) => {
  logger.info({
    event: 'file_access',
    shareToken,
    ipAddress,
    success,
    timestamp: new Date().toISOString()
  });
};

export const logAuthentication = (email, success, method) => {
  logger.info({
    event: 'authentication',
    email,
    success,
    method,
    timestamp: new Date().toISOString()
  });
};

export const logError = (error, context = {}) => {
  logger.error({
    error: error.message,
    stack: error.stack,
    ...context,
    timestamp: new Date().toISOString()
  });
};

export const logCleanup = (type, count) => {
  logger.info({
    event: 'cleanup',
    type,
    itemsDeleted: count,
    timestamp: new Date().toISOString()
  });
};

export const logSubscriptionChange = (userId, oldTier, newTier) => {
  logger.info({
    event: 'subscription_change',
    userId,
    oldTier,
    newTier,
    timestamp: new Date().toISOString()
  });
};

export default logger;

