import express from 'express';
import { supabaseAdmin } from '../../config/supabase.js';
import { authMiddleware } from '../middleware/auth.js';
import { shareLimiter, passwordLimiter } from '../middleware/rateLimiter.js';
import { validateShareLink, validateShareAccess, validatePassword, validateUUID, validateOTP } from '../middleware/validators.js';
import { sendShareLinkEmail, sendOTPEmail } from '../utils/email.js';
import { generateOTP, storeOTP, verifyOTP } from '../utils/otp.js';
import logger, { logShareLinkCreated, logFileAccess } from '../utils/logger.js';
import bcrypt from 'bcrypt';
import QRCode from 'qrcode';

const router = express.Router();

// Create anonymous share link (no authentication required)
router.post('/anonymous', validateShareLink, async (req, res) => {
  try {
    const {
      file_id,
      expires_at,
      max_opens,
      password,
      require_otp,
      qr_code_enabled
    } = req.body;

    // Verify file exists and is anonymous
    const { data: fileData, error: fileError } = await supabaseAdmin
      .from('uploaded_files')
      .select('*')
      .eq('id', file_id)
      .is('user_id', null)
      .single();

    if (fileError || !fileData) {
      return res.status(404).json({ error: 'File not found or not accessible' });
    }

    // Generate unique share token
    const share_token = Math.random().toString(36).substring(2, 15) + 
                       Math.random().toString(36).substring(2, 15);

    // Hash password if provided
    let password_hash = null;
    if (password && password.trim().length > 0) {
      const saltRounds = 10;
      password_hash = await bcrypt.hash(password, saltRounds);
    }

    const { data, error } = await supabaseAdmin
      .from('share_links')
      .insert({
        file_id,
        user_id: null, // Anonymous share links have no user_id
        share_token,
        expires_at: expires_at || (password_hash ? null : fileData.expires_at), // No expiration if password protected
        max_opens: max_opens || null,
        current_opens: 0,
        password_hash,
        require_otp: require_otp || false,
        qr_code_enabled: qr_code_enabled || false,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      logger.error('Share link creation error:', error);
      return res.status(500).json({ error: 'Failed to create share link' });
    }

    // Generate QR code if requested
    let qr_code_url = null;
    if (qr_code_enabled) {
      try {
        const shareUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/share/${share_token}`;
        const qrCodeDataURL = await QRCode.toDataURL(shareUrl);
        
        // Upload QR code to storage
        const qrFileName = `qr-codes/${share_token}.png`;
        const qrBuffer = Buffer.from(qrCodeDataURL.split(',')[1], 'base64');
        
        const { error: qrUploadError } = await supabaseAdmin.storage
          .from('files')
          .upload(qrFileName, qrBuffer, {
            contentType: 'image/png',
            cacheControl: '3600',
            upsert: true
          });

        if (!qrUploadError) {
          const { data: { publicUrl } } = supabaseAdmin.storage
            .from('files')
            .getPublicUrl(qrFileName);
          qr_code_url = publicUrl;
        }
      } catch (qrError) {
        logger.warn('QR code generation failed:', qrError);
      }
    }

    logger.info(`Anonymous share link created: ${share_token}`);

    res.status(201).json({
      share_token,
      share_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/share/${share_token}`,
      expires_at: data.expires_at,
      max_opens: data.max_opens,
      has_password: !!password_hash,
      require_otp: data.require_otp,
      qr_code_url,
      file_name: fileData.original_name,
      file_size: fileData.file_size
    });

  } catch (error) {
    logger.error('Anonymous share link creation error:', error);
    res.status(500).json({ error: 'Failed to create share link' });
  }
});

// Create share link - AUTHENTICATED USERS
router.post('/', authMiddleware, validateShareLink, async (req, res) => {
  try {
    console.log('=== SHARE LINK CREATION START ===');
    console.log('Request body:', req.body);
    console.log('User:', req.user ? {
      id: req.user.id,
      email: req.user.email
    } : 'No user');

    const {
      file_id,
      expires_at,
      max_opens,
      password,
      require_otp,
      otp_email,
      qr_code_enabled
    } = req.body;

    // Verify file ownership
    const { data: fileData, error: fileError } = await supabaseAdmin
      .from('uploaded_files')
      .select('*')
      .eq('id', file_id)
      .eq('user_id', req.user.id)
      .single();

    if (fileError || !fileData) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Generate unique share token
    const share_token = Math.random().toString(36).substring(2, 15) + 
                       Math.random().toString(36).substring(2, 15);

    // Hash password if provided
    let password_hash = null;
    if (password && password.trim().length > 0) {
      const saltRounds = 10;
      password_hash = await bcrypt.hash(password, saltRounds);
    }

    // Check user's watermark status and QR code limit
    const { data: userData, error: userError } = await supabaseAdmin
      .from('users')
      .select('subscription_tier, free_uploads_without_watermark, qr_codes_generated')
      .eq('id', req.user.id)
      .single();

    if (userError) {
      console.error('Error fetching user data:', userError);
      throw new Error('Failed to fetch user data');
    }

    // Check QR code limit for free users
    if (qr_code_enabled && userData.subscription_tier === 'free' && userData.qr_codes_generated >= 5) {
      return res.status(403).json({ 
        error: 'QR code limit reached',
        message: 'Free users can generate up to 5 QR codes. Upgrade to Pro for unlimited QR codes.'
      });
    }

    // Determine if watermark should be applied
    const shouldApplyWatermark = userData.subscription_tier === 'free' && 
                                userData.free_uploads_without_watermark <= 0;

    // Decrement free uploads counter for free users (only if they have remaining free uploads)
    if (userData.subscription_tier === 'free' && userData.free_uploads_without_watermark > 0) {
      await supabaseAdmin
        .from('users')
        .update({ 
          free_uploads_without_watermark: userData.free_uploads_without_watermark - 1 
        })
        .eq('id', req.user.id);
    }

    // Get download_allowed from request body (default to true)
    const { download_allowed = true } = req.body;

    const { data, error } = await supabaseAdmin
      .from('share_links')
      .insert({
        file_id,
        user_id: req.user.id,
        share_token,
        expires_at: expires_at || (password_hash ? null : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()), // No expiration if password protected, default 24h otherwise
        max_opens,
        password_hash,
        require_otp,
        otp_email,
        qr_code_enabled,
        has_watermark: shouldApplyWatermark,
        download_allowed
      })
      .select()
      .single();

    if (error) throw error;

    const shareUrl = `${process.env.FRONTEND_URL}/share/${share_token}`;

    // Send email notification if recipient email provided
    const { recipient_email, sender_name } = req.body;
    if (recipient_email) {
      const emailData = {
        shareUrl,
        filename: fileData.filename,
        senderName: sender_name || req.user.email,
        expiresAt: expires_at,
        hasPassword: !!password_hash,
        maxOpens: max_opens,
      };
      
      // Send email asynchronously (don't wait for it)
      sendShareLinkEmail(recipient_email, emailData).catch(err => {
        console.error('Failed to send email notification:', err);
      });
    }

    // Generate QR code if requested
    let qrCodeDataURL = null;
    if (qr_code_enabled) {
      try {
        qrCodeDataURL = await QRCode.toDataURL(shareUrl, {
          errorCorrectionLevel: 'H',
          type: 'image/png',
          quality: 0.92,
          margin: 1,
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          },
          width: 300
        });
        
        // Increment QR code counter for free users
        if (userData.subscription_tier === 'free') {
          await supabaseAdmin
            .from('users')
            .update({ 
              qr_codes_generated: userData.qr_codes_generated + 1 
            })
            .eq('id', req.user.id);
        }
      } catch (qrError) {
        console.error('Failed to generate QR code:', qrError);
        // Continue without QR code
      }
    }

    // Log share link creation
    logShareLinkCreated(req.user.id, share_token, !!password_hash, require_otp);

    res.json({
      share_link: {
        ...data,
        password_hash: undefined, // Don't send hash to client
        has_password: !!password_hash
      },
      url: shareUrl,
      email_sent: !!recipient_email,
      qr_code: qrCodeDataURL,
      watermark_info: {
        has_watermark: shouldApplyWatermark,
        remaining_free_uploads: Math.max(0, userData.free_uploads_without_watermark - 1),
        is_pro_user: userData.subscription_tier === 'pro'
      },
      qr_info: {
        qr_codes_generated: userData.qr_codes_generated + (qr_code_enabled ? 1 : 0),
        qr_codes_remaining: userData.subscription_tier === 'free' 
          ? Math.max(0, 5 - (userData.qr_codes_generated + (qr_code_enabled ? 1 : 0)))
          : null, // Pro users have unlimited
        is_pro_user: userData.subscription_tier === 'pro'
      }
    });
  } catch (error) {
    console.error('=== SHARE LINK CREATION ERROR ===');
    console.error('Error:', error);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    console.error('Request body:', req.body);
    console.error('User:', req.user?.id);
    
    logger.error('Error creating share link:', error);
    res.status(500).json({ error: 'Failed to create share link' });
  }
});

// Get share link by token (public)
router.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const { data, error } = await supabaseAdmin
      .from('share_links')
      .select(`
        *,
        uploaded_files (*)
      `)
      .eq('share_token', token)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Share link not found' });
    }

    // Check if expired
    if (new Date(data.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Share link expired' });
    }

    // Check if max opens reached
    if (data.max_opens && data.current_opens >= data.max_opens) {
      return res.status(410).json({ error: 'Maximum opens reached' });
    }

    // Don't send password hash to client, but indicate if password is required
    res.json({ 
      share_link: {
        ...data,
        password_hash: undefined,
        has_password: !!data.password_hash,
        has_watermark: data.has_watermark || false,
        otp_email: data.otp_email,
        uploaded_files: data.password_hash ? {
          id: data.uploaded_files.id,
          filename: data.uploaded_files.filename,
          file_size: data.uploaded_files.file_size,
          file_type: data.uploaded_files.file_type
          // Don't send file_url until password is verified
        } : data.uploaded_files
      }
    });
  } catch (error) {
    console.error('Error fetching share link:', error);
    res.status(500).json({ error: 'Failed to fetch share link' });
  }
});

// Verify password for share link
router.post('/:token/verify-password', passwordLimiter, validatePassword, async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    const { data: linkData, error: linkError } = await supabaseAdmin
      .from('share_links')
      .select('id, password_hash')
      .eq('share_token', token)
      .single();

    if (linkError || !linkData) {
      return res.status(404).json({ error: 'Share link not found' });
    }

    if (!linkData.password_hash) {
      return res.status(400).json({ error: 'This link is not password protected' });
    }

    // Verify password
    const isValid = await bcrypt.compare(password, linkData.password_hash);

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    res.json({ success: true, message: 'Password verified' });
  } catch (error) {
    console.error('Error verifying password:', error);
    res.status(500).json({ error: 'Failed to verify password' });
  }
});

// Request OTP for share link
router.post('/:token/request-otp', shareLimiter, async (req, res) => {
  try {
    const { token } = req.params;
    const { email } = req.body;

    console.log(`🔍 OTP Request - Token: ${token}, Email: ${email}`);
    console.log(`🔍 Environment check - EMAIL_USER: ${process.env.EMAIL_USER ? 'SET' : 'NOT SET'}, EMAIL_PASSWORD: ${process.env.EMAIL_PASSWORD ? 'SET' : 'NOT SET'}`);

    if (!email) {
      console.log('❌ No email provided in request');
      return res.status(400).json({ error: 'Email is required' });
    }

    // Check if share link exists and requires OTP
    console.log(`🔍 Checking share link for token: ${token}`);
    const { data: linkData, error: linkError } = await supabaseAdmin
      .from('share_links')
      .select('id, require_otp, expires_at')
      .eq('share_token', token)
      .single();

    if (linkError || !linkData) {
      console.log(`❌ Share link not found - Error: ${linkError?.message || 'No data'}`);
      return res.status(404).json({ error: 'Share link not found' });
    }

    console.log(`✅ Share link found - ID: ${linkData.id}, require_otp: ${linkData.require_otp}, expires_at: ${linkData.expires_at}`);

    if (!linkData.require_otp) {
      console.log('❌ Share link does not require OTP');
      return res.status(400).json({ error: 'This share link does not require OTP' });
    }

    // Check if expired
    const now = new Date();
    const expiresAt = new Date(linkData.expires_at);
    console.log(`🔍 Checking expiration - Now: ${now.toISOString()}, Expires: ${expiresAt.toISOString()}`);
    
    if (expiresAt < now) {
      console.log('❌ Share link has expired');
      return res.status(410).json({ error: 'Share link expired' });
    }

    // Generate and store OTP
    const otp = generateOTP();
    const identifier = `${token}:${email}`;
    storeOTP(identifier, otp);

    console.log(`Generated OTP for ${email}: ${otp} (identifier: ${identifier})`);

    // Send OTP via email
    console.log(`📧 Attempting to send OTP email to: ${email}`);
    const emailResult = await sendOTPEmail(email, otp);
    console.log(`📧 Email sending result:`, emailResult);

    if (!emailResult.success) {
      console.error('Failed to send OTP email:', emailResult);
      console.log(`⚠️ Email sending failed but OTP generated: ${otp}`);
      
      // Check if email is configured
      if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
        console.error('❌ EMAIL_USER or EMAIL_PASSWORD not configured in environment variables');
        console.log(`🔑 For testing purposes, OTP is: ${otp}`);
        
        // Return success with OTP for testing (remove in production)
        return res.json({
          message: 'OTP generated (email not configured)',
          otp: otp, // Only for testing - remove in production
          expiresIn: 600,
          warning: 'Email service not configured'
        });
      }
      
      // Email is configured but sending failed - still return OTP for testing
      console.log(`🔑 Email configured but sending failed. OTP is: ${otp}`);
      return res.json({
        message: 'OTP generated (email sending failed)',
        otp: otp, // Only for testing - remove in production
        expiresIn: 600,
        warning: 'Email sending failed but OTP is available'
      });
    }

    console.log(`✅ OTP sent successfully to ${email}`);
    
    res.json({
      message: 'OTP sent successfully',
      expiresIn: 600 // 10 minutes in seconds
    });
  } catch (error) {
    console.error('Error requesting OTP:', error);
    res.status(500).json({ 
      error: 'Failed to request OTP',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Verify OTP for share link
router.post('/:token/verify-otp', shareLimiter, validateOTP, async (req, res) => {
  try {
    const { token } = req.params;
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and OTP are required' });
    }

    const identifier = `${token}:${email}`;
    const verification = verifyOTP(identifier, otp);

    if (!verification.valid) {
      return res.status(401).json({
        error: verification.error,
        attemptsLeft: verification.attemptsLeft
      });
    }

    res.json({
      success: true,
      message: 'OTP verified successfully',
      verified: true
    });
  } catch (error) {
    console.error('Error verifying OTP:', error);
    res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

// Access file via share link (increments counter)
router.post('/:token/access', shareLimiter, validateShareAccess, async (req, res) => {
  try {
    const { token } = req.params;
    const { ip_address, password, otp, email } = req.body;

    const { data: linkData, error: linkError } = await supabaseAdmin
      .from('share_links')
      .select(`
        *,
        uploaded_files (*)
      `)
      .eq('share_token', token)
      .single();

    if (linkError || !linkData) {
      if (linkData?.id) {
        await supabaseAdmin
          .from('access_logs')
          .insert({
            share_link_id: linkData.id,
            ip_address: ip_address || 'unknown',
            success: false
          });
      }
      return res.status(404).json({ error: 'Share link not found' });
    }

    // Check if expired
    if (new Date(linkData.expires_at) < new Date()) {
      await supabaseAdmin
        .from('access_logs')
        .insert({
          share_link_id: linkData.id,
          ip_address: ip_address || 'unknown',
          success: false
        });
      return res.status(410).json({ error: 'Share link expired' });
    }

    // Check if max opens reached
    if (linkData.max_opens && linkData.current_opens >= linkData.max_opens) {
      await supabaseAdmin
        .from('access_logs')
        .insert({
          share_link_id: linkData.id,
          ip_address: ip_address || 'unknown',
          success: false
        });
      return res.status(410).json({ error: 'Maximum opens reached' });
    }

    // Verify password if required
    if (linkData.password_hash) {
      if (!password) {
        return res.status(401).json({ error: 'Password required' });
      }

      const isValid = await bcrypt.compare(password, linkData.password_hash);
      if (!isValid) {
        await supabaseAdmin
          .from('access_logs')
          .insert({
            share_link_id: linkData.id,
            ip_address: ip_address || 'unknown',
            success: false
          });
        return res.status(401).json({ error: 'Invalid password' });
      }
    }

    // Verify OTP if required
    if (linkData.require_otp) {
      if (!otp || !email) {
        return res.status(401).json({ error: 'OTP and email required' });
      }

      const identifier = `${token}:${email}`;
      const verification = verifyOTP(identifier, otp);

      if (!verification.valid) {
        await supabaseAdmin
          .from('access_logs')
          .insert({
            share_link_id: linkData.id,
            ip_address: ip_address || 'unknown',
            success: false
          });
        return res.status(401).json({
          error: verification.error,
          attemptsLeft: verification.attemptsLeft
        });
      }
    }

    // Increment counter
    const { error: updateError } = await supabaseAdmin
      .from('share_links')
      .update({ current_opens: linkData.current_opens + 1 })
      .eq('id', linkData.id);

    if (updateError) throw updateError;

    // Log access
    await supabaseAdmin
      .from('access_logs')
      .insert({
        share_link_id: linkData.id,
        ip_address,
        success: true
      });

    // Generate signed URL for file download
    const filePath = linkData.uploaded_files.file_url.split('/').slice(-2).join('/');
    const { data: signedUrlData, error: urlError } = await supabaseAdmin.storage
      .from('user-files')
      .createSignedUrl(filePath, 3600); // 1 hour expiry

    if (urlError) throw urlError;

    res.json({
      file: linkData.uploaded_files,
      download_url: signedUrlData.signedUrl
    });
  } catch (error) {
    console.error('Error accessing file:', error);
    res.status(500).json({ error: 'Failed to access file' });
  }
});

// Get user's share links
router.get('/user/links', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('share_links')
      .select(`
        *,
        uploaded_files (filename, file_size)
      `)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ share_links: data });
  } catch (error) {
    console.error('Error fetching share links:', error);
    res.status(500).json({ error: 'Failed to fetch share links' });
  }
});

// Get user's share link history
router.get('/user/history', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('share_link_history')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ history: data });
  } catch (error) {
    console.error('Error fetching share link history:', error);
    res.status(500).json({ error: 'Failed to fetch share link history' });
  }
});

// Delete share link
router.delete('/:linkId', authMiddleware, validateUUID, async (req, res) => {
  try {
    const { linkId } = req.params;

    // Verify ownership
    const { data: linkData, error: fetchError } = await supabaseAdmin
      .from('share_links')
      .select('*')
      .eq('id', linkId)
      .eq('user_id', req.user.id)
      .single();

    if (fetchError || !linkData) {
      return res.status(404).json({ error: 'Share link not found' });
    }

    const { error } = await supabaseAdmin
      .from('share_links')
      .delete()
      .eq('id', linkId);

    if (error) throw error;

    res.json({ message: 'Share link deleted successfully' });
  } catch (error) {
    console.error('Error deleting share link:', error);
    res.status(500).json({ error: 'Failed to delete share link' });
  }
});

// Get QR code for a share link
router.get('/:linkId/qrcode', authMiddleware, validateUUID, async (req, res) => {
  try {
    const { linkId } = req.params;

    // Verify ownership
    const { data: linkData, error: linkError } = await supabaseAdmin
      .from('share_links')
      .select('share_token, qr_code_enabled')
      .eq('id', linkId)
      .eq('user_id', req.user.id)
      .single();

    if (linkError || !linkData) {
      return res.status(404).json({ error: 'Share link not found' });
    }

    const shareUrl = `${process.env.FRONTEND_URL}/share/${linkData.share_token}`;

    // Generate QR code
    try {
      const qrCodeDataURL = await QRCode.toDataURL(shareUrl, {
        errorCorrectionLevel: 'H',
        type: 'image/png',
        quality: 0.92,
        margin: 1,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        },
        width: 300
      });

      res.json({ 
        qr_code: qrCodeDataURL,
        url: shareUrl
      });
    } catch (qrError) {
      console.error('Failed to generate QR code:', qrError);
      throw new Error('QR code generation failed');
    }
  } catch (error) {
    console.error('Error generating QR code:', error);
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Get access logs for a share link
router.get('/:linkId/logs', authMiddleware, validateUUID, async (req, res) => {
  try {
    const { linkId } = req.params;

    // Verify ownership
    const { data: linkData, error: linkError } = await supabaseAdmin
      .from('share_links')
      .select('*')
      .eq('id', linkId)
      .eq('user_id', req.user.id)
      .single();

    if (linkError || !linkData) {
      return res.status(404).json({ error: 'Share link not found' });
    }

    const { data, error } = await supabaseAdmin
      .from('access_logs')
      .select('*')
      .eq('share_link_id', linkId)
      .order('accessed_at', { ascending: false });

    if (error) throw error;

    res.json({ logs: data });
  } catch (error) {
    console.error('Error fetching logs:', error);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

export default router;
