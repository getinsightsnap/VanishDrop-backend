const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const mime = require('mime-types');
const fileType = require('file-type');

// Generate secure random token (length = bytes)
const generateToken = (length = 32) => crypto.randomBytes(length).toString('hex');

// Generate cryptographically secure 6‑digit OTP
const generateOTP = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

// Hash password
const hashPassword = (password) => {
  const bcrypt = require('bcryptjs');
  return bcrypt.hashSync(password, parseInt(process.env.BCRYPT_ROUNDS, 10) || 12);
};

// Verify password
const verifyPassword = (password, hash) => {
  const bcrypt = require('bcryptjs');
  return bcrypt.compareSync(password, hash);
};

// Validate file type
const validateFileType = async (filePath) => {
  try {
    const detectedType = await fileType.fromFile(filePath);

    const blockedTypes = new Set([
      'application/x-executable',
      'application/x-msdownload',
      'application/x-msdos-program',
      'application/x-winexe',
      'application/vnd.microsoft.portable-executable',
    ]);

    if (detectedType && blockedTypes.has(detectedType.mime)) {
      return { valid: false, reason: 'Executable files are not allowed for security reasons' };
    }

    return { valid: true, type: detectedType };
  } catch (error) {
    console.warn('File type detection failed:', error);
    return { valid: true, type: null };
  }
};

// Sanitize filename
const sanitizeFilename = (filename) =>
  filename.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 255);

// Get file extension
const getFileExtension = (filename) => path.extname(filename).toLowerCase();

// Format file size
const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

// Check if file exists
const fileExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

// Delete file safely
const deleteFile = async (filePath) => {
  try {
    if (await fileExists(filePath)) {
      await fs.unlink(filePath);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error deleting file:', error);
    return false;
  }
};

// Create secure file path
const createSecureFilePath = (originalName, token) => {
  const uploadDir = process.env.UPLOAD_DIR || '/tmp/vanishdrop';
  const sanitizedName = sanitizeFilename(originalName);
  const extension = getFileExtension(sanitizedName);
  const secureFilename = `${token}${extension}`;

  return {
    fullPath: path.join(uploadDir, secureFilename),
    filename: secureFilename,
    originalName: sanitizedName,
  };
};

module.exports = {
  generateToken,
  generateOTP,
  hashPassword,
  verifyPassword,
  validateFileType,
  sanitizeFilename,
  getFileExtension,
  formatFileSize,
  fileExists,
  deleteFile,
  createSecureFilePath,
};
