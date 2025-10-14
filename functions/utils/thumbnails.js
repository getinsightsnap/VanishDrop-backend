import sharp from 'sharp';
import { supabaseAdmin } from '../../config/supabase.js';

// Generate thumbnail for image files
export const generateImageThumbnail = async (fileBuffer, options = {}) => {
  try {
    const {
      width = 300,
      height = 300,
      fit = 'cover',
      quality = 80
    } = options;

    const thumbnail = await sharp(fileBuffer)
      .resize(width, height, { fit })
      .jpeg({ quality })
      .toBuffer();

    return {
      success: true,
      thumbnail,
      mimeType: 'image/jpeg'
    };
  } catch (error) {
    console.error('Error generating thumbnail:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// Upload thumbnail to storage
export const uploadThumbnail = async (userId, fileId, thumbnailBuffer) => {
  try {
    const thumbnailPath = `${userId}/thumbnails/${fileId}.jpg`;

    const { data, error } = await supabaseAdmin.storage
      .from('user-files')
      .upload(thumbnailPath, thumbnailBuffer, {
        contentType: 'image/jpeg',
        cacheControl: '31536000', // 1 year
        upsert: true
      });

    if (error) throw error;

    const { data: { publicUrl } } = supabaseAdmin.storage
      .from('user-files')
      .getPublicUrl(thumbnailPath);

    return {
      success: true,
      thumbnailUrl: publicUrl
    };
  } catch (error) {
    console.error('Error uploading thumbnail:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// Check if file type supports thumbnails
export const supportsThumbnail = (mimeType) => {
  const supportedTypes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/svg+xml',
    'image/bmp',
    'image/tiff'
  ];

  return supportedTypes.includes(mimeType);
};

// Get file icon based on type
export const getFileIcon = (mimeType) => {
  const type = mimeType.split('/')[0];
  const subtype = mimeType.split('/')[1];

  const icons = {
    'image': '🖼️',
    'video': '🎥',
    'audio': '🎵',
    'application/pdf': '📄',
    'application/msword': '📝',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '📝',
    'application/vnd.ms-excel': '📊',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '📊',
    'application/vnd.ms-powerpoint': '📽️',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '📽️',
    'application/zip': '📦',
    'application/x-rar-compressed': '📦',
    'application/x-7z-compressed': '📦',
    'text/plain': '📃',
    'text/html': '🌐',
    'text/css': '🎨',
    'application/javascript': '💻',
    'application/json': '📋'
  };

  // Check for exact match first
  if (icons[mimeType]) {
    return icons[mimeType];
  }

  // Check for general type
  if (icons[type]) {
    return icons[type];
  }

  // Default icon
  return '📎';
};

// Get file category
export const getFileCategory = (mimeType) => {
  const type = mimeType.split('/')[0];

  const categories = {
    'image': 'Image',
    'video': 'Video',
    'audio': 'Audio',
    'text': 'Document',
    'application/pdf': 'Document',
    'application/msword': 'Document',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Document',
    'application/vnd.ms-excel': 'Spreadsheet',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Spreadsheet',
    'application/vnd.ms-powerpoint': 'Presentation',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'Presentation',
    'application/zip': 'Archive',
    'application/x-rar-compressed': 'Archive',
    'application/x-7z-compressed': 'Archive',
    'application/javascript': 'Code',
    'application/json': 'Data'
  };

  // Check for exact match
  if (categories[mimeType]) {
    return categories[mimeType];
  }

  // Check for general type
  if (categories[type]) {
    return categories[type];
  }

  return 'File';
};

export default {
  generateImageThumbnail,
  uploadThumbnail,
  supportsThumbnail,
  getFileIcon,
  getFileCategory
};

