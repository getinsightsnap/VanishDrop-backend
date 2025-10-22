import multer from 'multer';
import path from 'path';

// Configure multer for memory storage (files stored in memory before uploading to Supabase)
const storage = multer.memoryStorage();

// File filter to validate file types
const fileFilter = (req, file, cb) => {
  // List of allowed MIME types
  const allowedTypes = [
    // Documents
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
    // Images
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    // Videos
    'video/mp4',
    'video/mpeg',
    'video/quicktime',
    'video/x-msvideo',
    'video/webm',
    // Audio
    'audio/mpeg',
    'audio/wav',
    'audio/ogg',
    'audio/webm',
    // Archives
    'application/zip',
    'application/x-rar-compressed',
    'application/x-7z-compressed',
    'application/x-tar',
    'application/gzip',
    // Code files
    'application/json',
    'application/javascript',
    'text/html',
    'text/css',
    'application/xml',
    // Encrypted files (E2EE)
    'application/octet-stream',
  ];

  // Check if it's an encrypted file (has .encrypted extension or is_encrypted flag)
  const isEncrypted = file.originalname.endsWith('.encrypted') || 
                     (req.body && req.body.is_encrypted === 'true');

  if (allowedTypes.includes(file.mimetype) || isEncrypted) {
    console.log(`✅ File type allowed: ${file.mimetype} (encrypted: ${isEncrypted})`);
    cb(null, true);
  } else {
    console.log(`❌ File type rejected: ${file.mimetype}`);
    cb(new Error(`File type ${file.mimetype} is not allowed`), false);
  }
};

// Configure multer upload
export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 * 1024, // 10GB max (will be enforced by subscription tier)
  },
});

export default upload;

