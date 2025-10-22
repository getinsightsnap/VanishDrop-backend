import express from 'express';
import { supabaseAdmin } from '../../config/supabase.js';
import { authMiddleware } from '../middleware/auth.js';
import { upload } from '../middleware/upload.js';
import { uploadLimiter } from '../middleware/rateLimiter.js';
import { validateFileUpload, validateUUID } from '../middleware/validators.js';
// import { generateImageThumbnail, uploadThumbnail, supportsThumbnail } from '../utils/thumbnails.js';
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
    // If expires_in_hours is 0, set expiresAt to null (no expiry)
    const hoursToExpire = parseFloat(expires_in_hours);
    let expiresAt = null;
    
    if (hoursToExpire === 0) {
      // No expiry
      expiresAt = null;
    } else {
      expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + (hoursToExpire || 24));
    }

    // Save file metadata to database (without user_id)
    const { data: fileRecord, error: dbError } = await supabaseAdmin
      .from('uploaded_files')
      .insert({
        user_id: null, // Anonymous uploads have no user_id
        filename: file.originalname,
        file_size: file.size,
        file_type: file.mimetype,
        file_url: publicUrl,
        expires_at: expiresAt ? expiresAt.toISOString() : null
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
    // if (supportsThumbnail(file.mimetype)) {
    //   try {
    //     const thumbnailUrl = await generateImageThumbnail(file.buffer, fileName);
    //     await supabaseAdmin
    //       .from('uploaded_files')
    //       .update({ thumbnail_url: thumbnailUrl })
    //       .eq('id', fileRecord.id);
    //   } catch (thumbnailError) {
    //     logger.warn('Thumbnail generation failed:', thumbnailError);
    //   }
    // }

    logger.info(`Anonymous file uploaded: ${file.originalname} (${file.size} bytes)`);

    res.status(201).json({
      file_id: fileRecord.id,
      file_name: file.originalname,
      file_size: file.size,
      file_url: publicUrl,
      expires_at: expiresAt ? expiresAt.toISOString() : null,
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
    console.log('=== UPLOAD REQUEST START ===');
    console.log('🔍 Upload middleware chain completed successfully');
    console.log('Request body:', req.body);
    console.log('Request file:', req.file ? {
      fieldname: req.file.fieldname,
      originalname: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype
    } : 'No file');
    console.log('User:', req.user ? {
      id: req.user.id,
      email: req.user.email
    } : 'No user');

    if (!req.file) {
      console.log('ERROR: No file provided');
      return res.status(400).json({ error: 'No file provided' });
    }

    const { expires_in_hours, is_encrypted, encryption_iv, original_filename, original_file_type } = req.body;
    const user_id = req.user.id;
    const file = req.file;

    // Check upload limits
    let userData;
    const { data: existingUser, error: userError } = await supabaseAdmin
      .from('users')
      .select('daily_upload_used, daily_upload_reset_at, subscription_tier, lifetime_upload_used')
      .eq('id', user_id)
      .single();

    // If user doesn't exist in users table, create them with default values
    if (userError && userError.code === 'PGRST116') {
      console.log('User not found in users table, creating default profile...');
      console.log('User ID:', user_id);
      console.log('User email:', req.user.email);
      
      const now = new Date();
      const { data: newUser, error: createError } = await supabaseAdmin
        .from('users')
        .insert({
          id: user_id,
          email: req.user.email,
          subscription_tier: 'free',
          daily_upload_used: 0,
          daily_upload_reset_at: now.toISOString(),
          lifetime_upload_used: 0,
          trial_used: false,
          trial_end_date: null,
          created_at: now.toISOString(),
          updated_at: now.toISOString()
        })
        .select()
        .single();

      if (createError) {
        console.error('Failed to create user profile:', createError);
        console.error('Create error details:', JSON.stringify(createError, null, 2));
        return res.status(500).json({ 
          error: 'Failed to create user profile',
          details: createError.message,
          code: createError.code
        });
      }

      console.log('User profile created successfully:', newUser);
      userData = newUser;
    } else if (userError) {
      console.error('Error fetching user:', userError);
      throw userError;
    } else {
      userData = existingUser;
    }

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

    // Check file size limits - Free users can upload any size up to their lifetime limit
    const maxFileSize = 10 * 1024 * 1024 * 1024; // 10GB per file for all users

    if (file.size > maxFileSize) {
      return res.status(403).json({
        error: 'File size exceeds 10GB limit',
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
    // If expires_in_hours is 0, set expiresAt to null (no expiry for Pro users)
    const hoursToExpire = parseInt(expires_in_hours);
    let expiresAt = null;
    
    if (hoursToExpire === 0) {
      // No expiry - only for Pro users
      expiresAt = null;
    } else {
      expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + (hoursToExpire || 24));
    }

    // Generate thumbnail if it's an image
    let thumbnailUrl = null;
    // if (supportsThumbnail(file.mimetype)) {
    //   const thumbnailResult = await generateImageThumbnail(file.buffer, {
    //     width: 300,
    //     height: 300,
    //     fit: 'cover'
    //   });

    //   if (thumbnailResult.success) {
    //     const uploadResult = await uploadThumbnail(user_id, uniqueId, thumbnailResult.thumbnail);
    //     if (uploadResult.success) {
    //       thumbnailUrl = uploadResult.thumbnailUrl;
    //     }
    //   }
    // }

    // Create file record in database
    const { data: fileData, error: fileError } = await supabaseAdmin
      .from('uploaded_files')
      .insert({
        user_id,
        filename: is_encrypted === 'true' ? original_filename : file.originalname,
        file_size: file.size,
        file_type: is_encrypted === 'true' ? original_file_type : file.mimetype,
        file_url: publicUrl,
        expires_at: expiresAt ? expiresAt.toISOString() : null,
        is_encrypted: is_encrypted === 'true',
        encryption_iv: is_encrypted === 'true' ? encryption_iv : null,
        original_filename: is_encrypted === 'true' ? original_filename : null,
        original_file_type: is_encrypted === 'true' ? original_file_type : null
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
    console.error('❌ File upload error:', error);
    console.error('❌ Error stack:', error.stack);
    console.error('❌ User ID:', req.user?.id);
    console.error('❌ File:', req.file?.originalname, req.file?.size);
    console.error('❌ Error type:', error.constructor.name);
    console.error('❌ Error message:', error.message);
    
    logError(error, {
      context: 'file_upload',
      userId: req.user?.id,
      filename: req.file?.originalname,
      fileSize: req.file?.size,
      errorStack: error.stack
    });
    
    res.status(500).json({ 
      error: 'Failed to upload file',
      message: error.message,
      type: error.constructor.name,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
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
