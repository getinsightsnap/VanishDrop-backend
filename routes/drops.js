const express = require('express');
const path = require('path');
const QRCode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const { pool } = require('../config/database');
const { verifyPassword } = require('../utils/fileUtils');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const router = express.Router();

// Get drop by token (one-time access)
router.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { password, otp } = req.query;

    // Find the drop
    const dropResult = await pool.query(
      'SELECT * FROM drops WHERE token = $1 AND expires_at > NOW()',
      [token]
    );

    if (dropResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Drop not found or expired',
        code: 'DROP_NOT_FOUND'
      });
    }

    const drop = dropResult.rows[0];

    // Check if already accessed (view_once)
    if (drop.view_once && drop.view_count >= 1) {
      return res.status(410).json({
        error: 'This drop has already been accessed and is no longer available',
        code: 'DROP_ALREADY_ACCESSED'
      });
    }

    // Handle password protection
    if (drop.password_hash && !password) {
      return res.status(401).json({
        error: 'Password required',
        code: 'PASSWORD_REQUIRED',
        requiresPassword: true
      });
    }

    if (drop.password_hash && !verifyPassword(password, drop.password_hash)) {
      return res.status(401).json({
        error: 'Invalid password',
        code: 'INVALID_PASSWORD'
      });
    }

    // Handle OTP protection
    if (drop.otp_code && !otp) {
      return res.status(401).json({
        error: 'OTP code required',
        code: 'OTP_REQUIRED',
        requiresOTP: true,
        otpExpired: drop.otp_expires_at && new Date() > new Date(drop.otp_expires_at)
      });
    }

    if (drop.otp_code && otp !== drop.otp_code) {
      return res.status(401).json({
        error: 'Invalid OTP code',
        code: 'INVALID_OTP'
      });
    }

    if (drop.otp_code && drop.otp_expires_at && new Date() > new Date(drop.otp_expires_at)) {
      return res.status(401).json({
        error: 'OTP code has expired',
        code: 'OTP_EXPIRED'
      });
    }

    // Update access count and last accessed
    await pool.query(
      'UPDATE drops SET view_count = view_count + 1, download_count = download_count + 1, last_accessed = NOW() WHERE id = $1',
      [drop.id]
    );

    // Log the download
    await pool.query(
      'INSERT INTO download_logs (drop_id, ip_address) VALUES ($1, $2)',
      [drop.id, req.ip]
    );

    // Update user stats if applicable
    if (drop.user_id) {
      await pool.query(`
        UPDATE user_stats 
        SET total_downloads = total_downloads + 1, updated_at = NOW()
        WHERE user_id = $1
      `, [drop.user_id]);
    }

    // Prepare response based on type
    if (drop.type === 'message') {
      res.json({
        success: true,
        type: 'message',
        content: drop.message_content,
        filename: null,
        fileSize: drop.file_size,
        mimetype: drop.mimetype,
        expiresAt: drop.expires_at,
        accessedAt: new Date().toISOString()
      });
    } else {
      // File download from Supabase Storage
      if (!drop.file_path) {
        return res.status(404).json({
          error: 'File not found',
          code: 'FILE_NOT_FOUND'
        });
      }

      try {
        // Get file from Supabase Storage
        const { data, error } = await supabase.storage
          .from('vanish-drop-files')
          .download(drop.file_path);

        if (error) {
          console.error('Supabase download error:', error);
          return res.status(404).json({
            error: 'File not found in storage',
            code: 'STORAGE_FILE_NOT_FOUND'
          });
        }

        // Convert blob to buffer
        const buffer = Buffer.from(await data.arrayBuffer());

        // Set headers for file download
        const filename = drop.original_filename || drop.filename || 'download';
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', drop.mimetype || 'application/octet-stream');
        res.setHeader('Content-Length', buffer.length);
        
        // Add security headers
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');

        // Send file buffer
        res.send(buffer);

      } catch (downloadError) {
        console.error('File download error:', downloadError);
        return res.status(500).json({
          error: 'File download failed',
          code: 'DOWNLOAD_ERROR'
        });
      }
    }

  } catch (error) {
    console.error('Drop access error:', error);
    res.status(500).json({
      error: 'Failed to access drop',
      code: 'ACCESS_ERROR'
    });
  }
});

// Get drop metadata (without accessing content)
router.get('/:token/info', async (req, res) => {
  try {
    const { token } = req.params;

    const dropResult = await pool.query(
      'SELECT id, type, original_filename, file_size, mimetype, expires_at, view_count, protection_type, created_at FROM drops WHERE token = $1',
      [token]
    );

    if (dropResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Drop not found',
        code: 'DROP_NOT_FOUND'
      });
    }

    const drop = dropResult.rows[0];

    // Check if expired
    const isExpired = new Date() > new Date(drop.expires_at);
    const isAccessed = drop.view_count >= 1;

    res.json({
      type: drop.type,
      filename: drop.original_filename,
      fileSize: drop.file_size,
      mimetype: drop.mimetype,
      expiresAt: drop.expires_at,
      isExpired,
      isAccessed,
      protectionType: drop.protection_type,
      requiresPassword: drop.protection_type.includes('password'),
      requiresOTP: drop.protection_type.includes('otp'),
      createdAt: drop.created_at
    });

  } catch (error) {
    console.error('Drop info error:', error);
    res.status(500).json({
      error: 'Failed to get drop info',
      code: 'INFO_ERROR'
    });
  }
});

// Generate QR code for drop
router.get('/:token/qr', async (req, res) => {
  try {
    const { token } = req.params;

    // Verify drop exists
    const dropResult = await pool.query(
      'SELECT id FROM drops WHERE token = $1 AND expires_at > NOW()',
      [token]
    );

    if (dropResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Drop not found or expired',
        code: 'DROP_NOT_FOUND'
      });
    }

    // Generate QR code
    const shareUrl = `${process.env.FRONTEND_URL}/f/${token}`;
    const qrCodeData = await QRCode.toDataURL(shareUrl, {
      width: 256,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });

    res.json({
      qrCode: qrCodeData,
      url: shareUrl
    });

  } catch (error) {
    console.error('QR code generation error:', error);
    res.status(500).json({
      error: 'Failed to generate QR code',
      code: 'QR_ERROR'
    });
  }
});

module.exports = router;