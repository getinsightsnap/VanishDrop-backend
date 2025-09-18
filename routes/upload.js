const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { pool } = require('../config/database');
const { validateTierLimits } = require('../utils/tierLimits');
const { rateLimitMiddleware, checkFreeTierLimits, incrementFreeTierUsage } = require('../middleware/rateLimiter');
const { 
  generateToken, 
  generateOTP, 
  hashPassword, 
  validateFileType,
  createSecureFilePath
} = require('../utils/fileUtils');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const router = express.Router();

// Configure multer for memory storage (we'll upload to Supabase)
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024 * 1024, // 10GB max (will be restricted by tier)
    files: 1
  },
  fileFilter: (req, file, cb) => {
    // Basic file type validation
    const allowedTypes = /\.(jpg|jpeg|png|gif|pdf|doc|docx|txt|zip|rar|mp4|mp3|avi|csv|xlsx)$/i;
    if (!allowedTypes.test(file.originalname)) {
      return cb(new Error('File type not allowed'), false);
    }
    cb(null, true);
  }
});

// Apply rate limiting
router.use(rateLimitMiddleware);
router.use(checkFreeTierLimits);

// Upload file endpoint
router.post('/', upload.single('file'), async (req, res) => {
  try {
    const { expiration, password, otp, message, generateQR } = req.body;
    const file = req.file;
    
    // Validate required fields
    if (!file && !message) {
      return res.status(400).json({
        error: 'Either file or message is required',
        code: 'MISSING_CONTENT'
      });
    }

    // Validate against tier limits
    const validationErrors = validateTierLimits(req, {
      expiration,
      password,
      otp: otp === 'true',
      generateQR: generateQR === 'true'
    });

    if (validationErrors.length > 0) {
      // Delete uploaded file if validation fails
      if (file) {
        const { deleteFile } = require('../utils/fileUtils');
        await deleteFile(file.path);
      }
      
      return res.status(400).json({
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: validationErrors
      });
    }

    // Additional file type validation
    if (file) {
      const typeValidation = await validateFileType(file.path);
      if (!typeValidation.valid) {
        const { deleteFile } = require('../utils/fileUtils');
        await deleteFile(file.path);
        
        return res.status(400).json({
          error: typeValidation.reason,
          code: 'INVALID_FILE_TYPE'
        });
      }
    }

    // Calculate expiration
    const expirationMinutes = parseInt(expiration) || 10;
    const expiresAt = new Date(Date.now() + (expirationMinutes * 60 * 1000));

    // Generate access token
    const token = generateToken(32);
    
    let filePath = null;
    let fileName = null;
    
    // Upload file to Supabase Storage if present
    if (file) {
      const fileExt = path.extname(file.originalname);
      fileName = `${token}${fileExt}`;
      filePath = `uploads/${fileName}`;
      
      try {
        const { data, error } = await supabase.storage
          .from('vanish-drop-files')
          .upload(filePath, file.buffer, {
            contentType: file.mimetype,
            upsert: false
          });

        if (error) {
          throw new Error(`File upload failed: ${error.message}`);
        }
        
        console.log(`✅ File uploaded to Supabase Storage: ${filePath}`);
      } catch (uploadError) {
        console.error('Supabase upload error:', uploadError);
        return res.status(500).json({
          error: 'File upload failed',
          code: 'STORAGE_ERROR',
          message: uploadError.message
        });
      }
    }

    // Prepare drop data
    const dropData = {
      token,
      user_id: req.userId || null,
      tier: req.userTier,
      type: file ? 'file' : 'message',
      filename: fileName,
      original_filename: file ? file.originalname : null,
      file_path: filePath,
      message_content: message || null,
      mimetype: file ? file.mimetype : 'text/plain',
      file_size: file ? file.size : (message ? message.length : 0),
      expires_at: expiresAt,
      view_once: true,
      view_count: 0,
      download_count: 0,
      ip_address: req.ip,
      protection_type: 'none'
    };

    // Handle password protection (Pro/Business only)
    if (password && req.tierLimits.allowPassword) {
      dropData.password_hash = hashPassword(password);
      dropData.protection_type = 'password';
    }

    // Handle OTP protection (Pro/Business only)
    if (otp === 'true' && req.tierLimits.allowOTP) {
      const otpCode = generateOTP();
      dropData.otp_code = otpCode;
      dropData.otp_expires_at = new Date(Date.now() + (10 * 60 * 1000)); // 10 minutes
      dropData.protection_type = dropData.protection_type === 'password' ? 'both' : 'otp';
    }

    // Generate QR code if requested (available for all tiers)
    let qrCodeData = null;
    if (generateQR === 'true') {
      const shareUrl = `${process.env.FRONTEND_URL}/f/${token}`;
      try {
        qrCodeData = await QRCode.toDataURL(shareUrl, {
          width: 256,
          margin: 2,
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          }
        });
        dropData.qr_code = qrCodeData;
      } catch (qrError) {
        console.warn('QR code generation failed:', qrError);
      }
    }

    // Insert into database
    const insertQuery = `
      INSERT INTO drops (
        token, user_id, tier, type, filename, original_filename, file_path,
        message_content, mimetype, file_size, password_hash, otp_code, otp_expires_at,
        expires_at, view_once, view_count, download_count, ip_address, protection_type, qr_code
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      RETURNING id, token, expires_at, protection_type
    `;

    const insertValues = [
      dropData.token, dropData.user_id, dropData.tier, dropData.type,
      dropData.filename, dropData.original_filename, dropData.file_path,
      dropData.message_content, dropData.mimetype, dropData.file_size,
      dropData.password_hash, dropData.otp_code, dropData.otp_expires_at,
      dropData.expires_at, dropData.view_once, dropData.view_count,
      dropData.download_count, dropData.ip_address, dropData.protection_type,
      dropData.qr_code
    ];

    const result = await pool.query(insertQuery, insertValues);
    const createdDrop = result.rows[0];

    // Update free tier usage counter
    if (req.userTier === 'free') {
      await incrementFreeTierUsage(req.ip);
    }

    // Update user stats for authenticated users
    if (req.userId) {
      await pool.query(`
        INSERT INTO user_stats (user_id, total_uploads, storage_used)
        VALUES ($1, 1, $2)
        ON CONFLICT (user_id)
        DO UPDATE SET
          total_uploads = user_stats.total_uploads + 1,
          storage_used = user_stats.storage_used + $2,
          updated_at = NOW()
      `, [req.userId, dropData.file_size]);
    }

    // Prepare response
    const response = {
      success: true,
      drop: {
        id: createdDrop.id,
        token: createdDrop.token,
        type: dropData.type,
        filename: dropData.original_filename,
        fileSize: dropData.file_size,
        expiresAt: createdDrop.expires_at,
        protectionType: createdDrop.protection_type,
        shareUrl: `${process.env.FRONTEND_URL}/f/${createdDrop.token}`,
        ...(qrCodeData && { qrCode: qrCodeData }),
        ...(dropData.otp_code && { otpCode: dropData.otp_code }) // Only include OTP in response
      }
    };

    res.status(201).json(response);

  } catch (error) {
    console.error('Upload error:', error);
    
    // Clean up file from Supabase Storage on error
    if (filePath) {
      try {
        await supabase.storage
          .from('vanish-drop-files')
          .remove([filePath]);
        console.log(`🧹 Cleaned up file from storage: ${filePath}`);
      } catch (cleanupError) {
        console.error('Storage cleanup error:', cleanupError);
      }
    }
    
    res.status(500).json({
      error: 'Upload failed',
      code: 'UPLOAD_ERROR',
      message: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Upload with password endpoint (Pro/Business only)
router.post('/password', upload.single('file'), async (req, res) => {
  if (!req.tierLimits.allowPassword) {
    return res.status(403).json({
      error: 'Password protection is only available for Pro and Business tiers',
      code: 'FEATURE_RESTRICTED',
      feature_restricted: true
    });
  }
  
  // Reuse the main upload logic but ensure password is set
  req.body.password = req.body.password || 'required';
  return router.handle(req, res);
});

// Upload with OTP endpoint (Pro/Business only)
router.post('/otp', upload.single('file'), async (req, res) => {
  if (!req.tierLimits.allowOTP) {
    return res.status(403).json({
      error: 'OTP protection is only available for Pro and Business tiers',
      code: 'FEATURE_RESTRICTED',
      feature_restricted: true
    });
  }
  
  // Reuse the main upload logic but ensure OTP is enabled
  req.body.otp = 'true';
  return router.handle(req, res);
});

module.exports = router;