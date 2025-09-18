const errorHandler = (err, req, res, next) => {
  console.error('Error:', err);

  // Default error
  let error = {
    message: 'Internal Server Error',
    status: 500,
    code: 'INTERNAL_ERROR'
  };

  // Handle specific error types
  if (err.name === 'ValidationError') {
    error = {
      message: 'Validation failed',
      status: 400,
      code: 'VALIDATION_ERROR',
      details: err.details
    };
  } else if (err.code === 'LIMIT_FILE_SIZE') {
    error = {
      message: 'File too large',
      status: 413,
      code: 'FILE_TOO_LARGE',
      maxSize: err.limit
    };
  } else if (err.code === 'LIMIT_FILE_COUNT') {
    error = {
      message: 'Too many files',
      status: 413,
      code: 'TOO_MANY_FILES',
      maxFiles: err.limit
    };
  } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    error = {
      message: 'Unexpected file field',
      status: 400,
      code: 'UNEXPECTED_FILE',
      field: err.field
    };
  } else if (err.name === 'MulterError') {
    error = {
      message: 'File upload error',
      status: 400,
      code: 'UPLOAD_ERROR',
      details: err.message
    };
  } else if (err.status) {
    error = {
      message: err.message,
      status: err.status,
      code: err.code || 'CUSTOM_ERROR'
    };
  }

  // Don't expose error details in production
  if (process.env.NODE_ENV === 'production' && error.status >= 500) {
    error.message = 'Internal Server Error';
    delete error.details;
  }

  res.status(error.status).json({
    error: error.message,
    code: error.code,
    ...(error.details && { details: error.details }),
    ...(error.maxSize && { maxSize: error.maxSize }),
    ...(error.maxFiles && { maxFiles: error.maxFiles }),
    timestamp: new Date().toISOString(),
    path: req.path
  });
};

module.exports = errorHandler;