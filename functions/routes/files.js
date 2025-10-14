import express from 'express';
import { supabaseAdmin } from '../../config/supabase.js';
import { authMiddleware } from '../middleware/auth.js';
import { upload } from '../middleware/upload.js';
import { uploadLimiter } from '../middleware/rateLimiter.js';
import { validateFileUpload, validateUUID } from '../middleware/validators.js';
import { generateImageThumbnail, uploadThumbnail, supportsThumbnail } from '../utils/thumbnails.js';
import logger, { logFileUpload, logError } from '../utils/logger.js';
import crypto from 'crypto';

const router = express.Router();

// Get user's files
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('uploaded_files')
      .select('*')
      .eq('user_id', req.user.id)
      .order('uploaded_at', { ascending: false });

    if (error) throw error;

    res.json({ files: data });
  } catch (error) {
    console.error('Error fetching files:', error);
    res.status(500).json({ error: 'Failed to fetch files' });
  }
});

// Anonymous upload file (no authentication required)
router.post('/anonymous-upload', uploadLimiter, upload.single('file'), validateFileUpload, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const { expires_in_hours } = req.body;
    const file = req.file;

    // Anonymous uploads have a 1GB lifetime limit (same as free users)
    const maxFileSize = 1024 * 1024 * 1024; // 1GB
    if (file.size > maxFileSize) {
      return res.status(413).json({ 
        error: 'File too large. Maximum size is 1GB for anonymous uploads.' 
      });
    }

    // Generate unique file path
    const fileExtension = file.originalname.split('.').pop() || '';
    const fileName = `${Date.now()}-${Math.random().toString(36).substring(2)}.${fileExtension}`;
    const filePath = `anonymous-uploads/${fileName}`;

    // Upload to Supabase Storage
    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from('files')
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        cacheControl: '3600',
        upsert: false
      });

    if (uploadError) {
      logger.error('Storage upload error:', uploadError);
      return res.status(500).json({ error: 'Failed to upload file to storage' });
    }

    // Generate public URL
    const { data: { publicUrl } } = supabaseAdmin.storage
      .from('files')
      .getPublicUrl(filePath);

    // Calculate expiration
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + (parseFloat(expires_in_hours) || 24));

    // Save file metadata to database (without user_id)
    const { data: fileRecord, error: dbError } = await supabaseAdmin
      .from('uploaded_files')
      .insert({
        original_name: file.originalname,
        file_name: fileName,
        file_path: filePath,
        file_url: publicUrl,
        file_size: file.size,
        mime_type: file.mimetype,
        expires_at: expiresAt.toISOString(),
        is_anonymous: true,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (dbError) {
      logger.error('Database insert error:', dbError);
      // Clean up uploaded file
      await supabaseAdmin.storage.from('files').remove([filePath]);
      return res.status(500).json({ error: 'Failed to save file metadata' });
    }

    // Generate thumbnail for images
    if (supportsThumbnail(file.mimetype)) {
      try {
        const thumbnailUrl = await generateImageThumbnail(file.buffer, fileName);
        await supabaseAdmin
          .from('uploaded_files')
          .update({ thumbnail_url: thumbnailUrl })
          .eq('id', fileRecord.id);
      } catch (thumbnailError) {
        logger.warn('Thumbnail generation failed:', thumbnailError);
      }
    }

    logger.info(`Anonymous file uploaded: ${file.originalname} (${file.size} bytes)`);

    res.status(201).json({
      file_id: fileRecord.id,
      file_name: file.originalname,
      file_size: file.size,
      file_url: publicUrl,
      expires_at: expiresAt.toISOString(),
      message: 'File uploaded successfully'
    });

  } catch (error) {
    logger.error('Anonymous upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Upload file (with actual file upload to Supabase Storage) - AUTHENTICATED USERS
router.post('/upload', uploadLimiter, authMiddleware, upload.single('file'), validateFileUpload, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const { expires_in_hours } = req.body;
    const user_id = req.user.id;
    const file = req.file;

    // Check upload limits
    const { data: userData, error: userError } = await supabaseAdmin
      .from('users')
      .select('daily_upload_used, daily_upload_reset_at, subscription_tier, lifetime_upload_used')
      .eq('id', user_id)
      .single();

    if (userError) throw userError;

    const now = new Date();
    let dailyUsed = userData.daily_upload_used;
    let lifetimeUsed = userData.lifetime_upload_used || 0;

    if (userData.subscription_tier === 'pro') {
      // Pro users: Check daily limits
      const resetTime = new Date(userData.daily_upload_reset_at);
      const hoursPassed = (now.getTime() - resetTime.getTime()) / (1000 * 60 * 60);

      if (hoursPassed >= 24) {
        dailyUsed = 0;
        await supabaseAdmin
          .from('users')
          .update({
            daily_upload_used: 0,
            daily_upload_reset_at: now.toISOString()
          })
          .eq('id', user_id);
      }

      // Check daily limit for Pro users
      const dailyLimit = 10 * 1024 * 1024 * 1024; // 10GB
      if (dailyUsed + file.size > dailyLimit) {
        return res.status(403).json({
          error: 'Daily upload limit exceeded',
          limit: dailyLimit,
          used: dailyUsed,
          fileSize: file.size
        });
      }
    } else {
      // Free users: Check lifetime limits
      const lifetimeLimit = 1024 * 1024 * 1024; // 1GB
      if (lifetimeUsed + file.size > lifetimeLimit) {
        return res.status(403).json({
          error: 'Lifetime upload limit exceeded',
          limit: lifetimeLimit,
          used: lifetimeUsed,
          fileSize: file.size
        });
      }
    }

    // Check file size limits
    const maxFileSize = userData.subscription_tier === 'pro'
      ? 10 * 1024 * 1024 * 1024 // 10GB per file
      : 100 * 1024 * 1024; // 100MB per file

    if (file.size > maxFileSize) {
      return res.status(403).json({
        error: `File size exceeds ${userData.subscription_tier === 'pro' ? '10GB' : '100MB'} limit`,
        maxSize: maxFileSize,
        fileSize: file.size
      });
    }

    // Generate unique file path
    const fileExt = file.originalname.split('.').pop();
    const uniqueId = crypto.randomBytes(16).toString('hex');
    const fileName = `${uniqueId}.${fileExt}`;
    const filePath = `${user_id}/${fileName}`;

    // Upload to Supabase Storage
    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from('user-files')
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        cacheControl: '3600',
        upsert: false
      });

    if (uploadError) {
      console.error('Storage upload error:', uploadError);
      throw new Error('Failed to upload file to storage');
    }

    // Get public URL (will need signed URL for access)
    const { data: { publicUrl } } = supabaseAdmin.storage
      .from('user-files')
      .getPublicUrl(filePath);

    // Calculate expiration time
    const hoursToExpire = parseInt(expires_in_hours) || 24;
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + hoursToExpire);

    // Generate thumbnail if it's an image
    let thumbnailUrl = null;
    if (supportsThumbnail(file.mimetype)) {
      const thumbnailResult = await generateImageThumbnail(file.buffer, {
        width: 300,
        height: 300,
        fit: 'cover'
      });

      if (thumbnailResult.success) {
        const uploadResult = await uploadThumbnail(user_id, uniqueId, thumbnailResult.thumbnail);
        if (uploadResult.success) {
          thumbnailUrl = uploadResult.thumbnailUrl;
        }
      }
    }

    // Create file record in database
    const { data: fileData, error: fileError } = await supabaseAdmin
      .from('uploaded_files')
      .insert({
        user_id,
        filename: file.originalname,
        file_size: file.size,
        file_type: file.mimetype,
        file_url: publicUrl,
        expires_at: expiresAt.toISOString()
      })
      .select()
      .single();

    if (fileError) {
      // Rollback: Delete uploaded file from storage
      await supabaseAdmin.storage
        .from('user-files')
        .remove([filePath]);
      
      // Also delete thumbnail if it was created
      if (thumbnailUrl) {
        const thumbnailPath = `${user_id}/thumbnails/${uniqueId}.jpg`;
        await supabaseAdmin.storage
          .from('user-files')
          .remove([thumbnailPath]);
      }
      
      throw fileError;
    }

    // Update usage based on subscription tier
    if (userData.subscription_tier === 'pro') {
      await supabaseAdmin
        .from('users')
        .update({
          daily_upload_used: dailyUsed + file.size
        })
        .eq('id', user_id);
    } else {
      await supabaseAdmin
        .from('users')
        .update({
          lifetime_upload_used: lifetimeUsed + file.size
        })
        .eq('id', user_id);
    }

    // Log successful upload
    logFileUpload(user_id, file.originalname, file.size, true);

    res.json({ 
      file: {
        ...fileData,
        thumbnail_url: thumbnailUrl
      },
      message: 'File uploaded successfully',
      has_thumbnail: !!thumbnailUrl
    });
  } catch (error) {
    logError(error, {
      context: 'file_upload',
      userId: req.user?.id,
      filename: req.file?.originalname
    });
    
    res.status(500).json({ 
      error: 'Failed to upload file',
      message: error.message 
    });
  }
});

// Delete file
router.delete('/:fileId', authMiddleware, validateUUID, async (req, res) => {
  try {
    const { fileId } = req.params;
    const user_id = req.user.id;

    // Verify ownership
    const { data: fileData, error: fetchError } = await supabaseAdmin
      .from('uploaded_files')
      .select('*')
      .eq('id', fileId)
      .eq('user_id', user_id)
      .single();

    if (fetchError || !fileData) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Delete from storage
    const filePath = fileData.file_url.split('/').pop();
    await supabaseAdmin.storage
      .from('user-files')
      .remove([`${user_id}/${filePath}`]);

    // Delete from database
    const { error: deleteError } = await supabaseAdmin
      .from('uploaded_files')
      .delete()
      .eq('id', fileId);

    if (deleteError) throw deleteError;

    res.json({ message: 'File deleted successfully' });
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// Get file by ID
router.get('/:fileId', authMiddleware, validateUUID, async (req, res) => {
  try {
    const { fileId } = req.params;

    const { data, error } = await supabaseAdmin
      .from('uploaded_files')
      .select('*')
      .eq('id', fileId)
      .eq('user_id', req.user.id)
      .single();

    if (error) throw error;

    res.json({ file: data });
  } catch (error) {
    console.error('Error fetching file:', error);
    res.status(404).json({ error: 'File not found' });
  }
});

export default router;
