import express from 'express';
import multer from 'multer';
import { supabaseAdmin } from '../../config/supabase.js';
import { authMiddleware } from '../middleware/auth.js';
import { shareLimiter, uploadLimiter } from '../middleware/rateLimiter.js';
import { sendDocumentRequestEmail, sendRequestFulfilledEmail } from '../utils/email.js';
import crypto from 'crypto';
import bcrypt from 'bcrypt';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// JSON middleware for routes that need it (non-upload routes)
const jsonParser = express.json();

// Generate unique request token
const generateRequestToken = () => {
  return crypto.randomBytes(16).toString('hex');
};

// Create new document request (Free users: 3 lifetime, Pro users: unlimited)
router.post('/create', jsonParser, authMiddleware, shareLimiter, async (req, res) => {
  try {
    const { recipient_email, request_message, upload_deadline } = req.body;
    const requester_id = req.user.id;

    // Validation
    if (!recipient_email || !request_message) {
      return res.status(400).json({ error: 'Recipient email and request message are required' });
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(recipient_email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    // Get user details and check tier
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('subscription_tier, lifetime_requests, email')
      .eq('id', requester_id)
      .single();

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check request limit
    if (user.subscription_tier === 'free' && user.lifetime_requests >= 3) {
      return res.status(403).json({ 
        error: 'Request limit reached. Upgrade to Pro for unlimited requests.',
        limit_reached: true
      });
    }

    // Validate upload deadline if provided
    if (upload_deadline) {
      const deadline = new Date(upload_deadline);
      if (deadline <= new Date()) {
        return res.status(400).json({ error: 'Upload deadline must be in the future' });
      }
    }

    // Generate unique request token
    const request_token = generateRequestToken();
    console.log('🔑 Generated request token:', request_token);

    // Create document request
    const { data: request, error: requestError } = await supabaseAdmin
      .from('document_requests')
      .insert({
        requester_id,
        recipient_email,
        request_message,
        request_token,
        upload_deadline: upload_deadline || null,
        status: 'pending'
      })
      .select()
      .single();

    if (requestError) {
      console.error('Error creating request:', requestError);
      return res.status(500).json({ error: 'Failed to create request' });
    }

    // Send email to recipient
    let emailSent = false;
    try {
      const requesterName = user.email.split('@')[0]; // Use email username as name
      await sendDocumentRequestEmail(
        recipient_email,
        requesterName,
        request_message,
        request_token,
        upload_deadline
      );
      emailSent = true;
      
      // Update email_sent status
      await supabaseAdmin
        .from('document_requests')
        .update({ 
          email_sent: true,
          email_sent_at: new Date().toISOString()
        })
        .eq('id', request.id);
    } catch (emailError) {
      console.error('Error sending request email:', emailError);
      // Don't fail the request creation if email fails
    }

    res.json({
      success: true,
      request: {
        id: request.id,
        request_token: request.request_token,
        status: request.status,
        created_at: request.created_at,
        upload_deadline: request.upload_deadline
      },
      requests_remaining: user.subscription_tier === 'pro' ? null : 3 - (user.lifetime_requests + 1)
    });

  } catch (error) {
    console.error('Error in create request:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get request details by token (public)
router.get('/:token', async (req, res) => { 
  try {
    const { token } = req.params;
    console.log('🔍 Looking for request with token:', token);

    const { data: request, error } = await supabaseAdmin
      .from('document_requests')
      .select('*')
      .eq('request_token', token)
      .single();

    console.log('🔍 Database query result:', { request, error });

    if (error || !request) {
      console.log('❌ Request not found for token:', token);
      return res.status(404).json({ error: 'Request not found' });
    }

    // Check if expired
    if (request.upload_deadline && new Date(request.upload_deadline) < new Date()) {
      // Auto-expire
      await supabaseAdmin
        .from('document_requests')
        .update({ status: 'expired' })
        .eq('id', request.id);

      request.status = 'expired';
    }

    // Get requester email separately
    const { data: requester, error: requesterError } = await supabaseAdmin
      .from('users')
      .select('email')
      .eq('id', request.requester_id)
      .single();

    res.json({
      request: {
        id: request.id,
        requester_email: requester?.email || 'Unknown',
        recipient_email: request.recipient_email,
        request_message: request.request_message,
        status: request.status,
        upload_deadline: request.upload_deadline,
        created_at: request.created_at,
        fulfilled_at: request.fulfilled_at
      }
    });

  } catch (error) {
    console.error('Error getting request:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Fulfill request with file upload (ANONYMOUS - NO AUTH REQUIRED)
router.post('/fulfill-upload', uploadLimiter, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const {
      request_token,
      expires_in_hours,
      password,
      require_otp,
      otp_email,
      max_opens,
      allow_download
    } = req.body;

    const file = req.file;

    // Get request details
    const { data: request, error: requestError } = await supabaseAdmin
      .from('document_requests')
      .select('*')
      .eq('request_token', request_token)
      .single();

    if (requestError || !request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    // Check if already fulfilled
    if (request.status !== 'pending') {
      return res.status(400).json({ error: `Request is ${request.status}` });
    }

    // Check if expired
    if (request.upload_deadline && new Date(request.upload_deadline) < new Date()) {
      await supabaseAdmin
        .from('document_requests')
        .update({ status: 'expired' })
        .eq('id', request.id);
      return res.status(410).json({ error: 'Request has expired' });
    }

    // Generate unique file name (anonymous upload - no user_id folder)
    const fileExtension = file.originalname.split('.').pop() || '';
    const uniqueId = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    const fileName = `${uniqueId}.${fileExtension}`;
    const filePath = `anonymous-fulfillments/${fileName}`;

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
      return res.status(500).json({ error: 'Failed to upload file to storage' });
    }

    // Get public URL
    const { data: { publicUrl } } = supabaseAdmin.storage
      .from('user-files')
      .getPublicUrl(filePath);

    // Calculate expiration time
    const hoursToExpire = parseInt(expires_in_hours) || 24;
    let expiresAt = null;
    
    if (hoursToExpire === 0) {
      expiresAt = null; // No expiry
    } else {
      expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + hoursToExpire);
    }

    // Create file record in database (anonymous upload - user_id = NULL)
    const { data: fileData, error: fileError } = await supabaseAdmin
      .from('uploaded_files')
      .insert({
        user_id: null, // Anonymous upload
        filename: file.originalname,
        file_size: file.size,
        file_type: file.mimetype,
        file_url: publicUrl,
        expires_at: expiresAt ? expiresAt.toISOString() : null,
        is_encrypted: false
      })
      .select()
      .single();

    if (fileError) {
      // Rollback: Delete uploaded file from storage
      await supabaseAdmin.storage
        .from('user-files')
        .remove([filePath]);
      console.error('Error creating file record:', fileError);
      return res.status(500).json({ error: 'Failed to create file record' });
    }

    // Hash password if provided
    let passwordHash = null;
    if (password) {
      passwordHash = await bcrypt.hash(password, 10);
    }

    // Generate unique share token
    const shareToken = crypto.randomBytes(16).toString('hex');

    // Create share link (anonymous upload - user_id = NULL)
    const { data: shareLink, error: shareLinkError } = await supabaseAdmin
      .from('share_links')
      .insert({
        user_id: null, // Anonymous upload
        file_id: fileData.id,
        share_token: shareToken,
        expires_at: expiresAt ? expiresAt.toISOString() : null,
        max_opens: max_opens ? parseInt(max_opens) : null,
        current_opens: 0,
        password_hash: passwordHash,
        require_otp: require_otp === 'true',
        otp_email: require_otp === 'true' ? otp_email : null,
        download_allowed: allow_download !== 'false'
      })
      .select()
      .single();

    if (shareLinkError) {
      // Rollback: Delete file and storage
      await supabaseAdmin.from('uploaded_files').delete().eq('id', fileData.id);
      await supabaseAdmin.storage.from('user-files').remove([filePath]);
      console.error('Error creating share link:', shareLinkError);
      return res.status(500).json({ error: 'Failed to create share link' });
    }

    // Update request status to fulfilled (no fulfilled_by_user_id for anonymous)
    const { error: updateError } = await supabaseAdmin
      .from('document_requests')
      .update({
        status: 'fulfilled',
        fulfilled_at: new Date().toISOString(),
        fulfilled_by_user_id: null, // Anonymous fulfillment
        share_link_id: shareLink.id
      })
      .eq('id', request.id);

    if (updateError) {
      console.error('Error updating request:', updateError);
      // Don't rollback here, just log the error
    }

    // Get requester details for notification
    const { data: requester } = await supabaseAdmin
      .from('users')
      .select('email')
      .eq('id', request.requester_id)
      .single();

    // Send notification email to requester
    if (requester) {
      try {
        const recipientName = request.recipient_email.split('@')[0];
        await sendRequestFulfilledEmail(
          requester.email,
          recipientName,
          shareLink.share_token,
          request.id
        );
        
        // Update notification_sent status
        await supabaseAdmin
          .from('document_requests')
          .update({ 
            notification_sent: true,
            notification_sent_at: new Date().toISOString()
          })
          .eq('id', request.id);
      } catch (emailError) {
        console.error('Error sending fulfillment email:', emailError);
      }
    }

    // Increment requester's request counter
    try {
      const { data: requesterData } = await supabaseAdmin
        .from('users')
        .select('lifetime_requests')
        .eq('id', request.requester_id)
        .single();
      
      if (requesterData) {
        await supabaseAdmin
          .from('users')
          .update({ 
            lifetime_requests: (requesterData.lifetime_requests || 0) + 1
          })
          .eq('id', request.requester_id);
      }
    } catch (counterError) {
      console.error('Error incrementing request counter:', counterError);
      // Don't fail the whole request if counter increment fails
    }

    res.json({
      success: true,
      message: 'File uploaded and request fulfilled successfully',
      share_token: shareLink.share_token,
      share_link_id: shareLink.id,
      file_id: fileData.id
    });

  } catch (error) {
    console.error('Error in fulfill-upload:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Legacy fulfill endpoint (keep for compatibility)
router.post('/:token/fulfill', jsonParser, authMiddleware, async (req, res) => {
  try {
    const { token } = req.params;
    const { share_link_id } = req.body;
    const fulfilled_by_user_id = req.user.id;

    if (!share_link_id) {
      return res.status(400).json({ error: 'Share link ID is required' });
    }

    // Get request details
    const { data: request, error: requestError } = await supabaseAdmin
      .from('document_requests')
      .select('*')
      .eq('request_token', token)
      .single();

    if (requestError || !request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    // Check if already fulfilled
    if (request.status !== 'pending') {
      return res.status(400).json({ error: `Request is ${request.status}` });
    }

    // Check if expired
    if (request.upload_deadline && new Date(request.upload_deadline) < new Date()) {
      await supabaseAdmin
        .from('document_requests')
        .update({ status: 'expired' })
        .eq('id', request.id);

      return res.status(410).json({ error: 'Request has expired' });
    }

    // Get user email to verify recipient
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('email')
      .eq('id', fulfilled_by_user_id)
      .single();

    if (!user || user.email !== request.recipient_email) {
      return res.status(403).json({ error: 'You are not the intended recipient of this request' });
    }

    // Verify share link exists and belongs to the user
    const { data: shareLink, error: shareLinkError } = await supabaseAdmin
      .from('share_links')
      .select('*')
      .eq('id', share_link_id)
      .eq('user_id', fulfilled_by_user_id)
      .single();

    if (shareLinkError || !shareLink) {
      return res.status(404).json({ error: 'Share link not found or does not belong to you' });
    }

    // Update request status to fulfilled
    const { error: updateError } = await supabaseAdmin
      .from('document_requests')
      .update({
        status: 'fulfilled',
        fulfilled_at: new Date().toISOString(),
        fulfilled_by_user_id,
        share_link_id
      })
      .eq('id', request.id);

    if (updateError) {
      console.error('Error updating request:', updateError);
      return res.status(500).json({ error: 'Failed to fulfill request' });
    }

    // Get requester details for notification
    const { data: requester } = await supabaseAdmin
      .from('users')
      .select('email')
      .eq('id', request.requester_id)
      .single();

    // Send notification email to requester
    if (requester) {
      try {
        const recipientName = user.email.split('@')[0];
        await sendRequestFulfilledEmail(
          requester.email,
          recipientName,
          shareLink.share_token,
          request.id
        );
        
        // Update notification_sent status
        await supabaseAdmin
          .from('document_requests')
          .update({ 
            notification_sent: true,
            notification_sent_at: new Date().toISOString()
          })
          .eq('id', request.id);
      } catch (emailError) {
        console.error('Error sending fulfillment email:', emailError);
      }
    }

    res.json({
      success: true,
      message: 'Request fulfilled successfully',
      share_token: shareLink.share_token
    });

  } catch (error) {
    console.error('Error fulfilling request:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's requests (as requester)
router.get('/my/requests', jsonParser, authMiddleware, async (req, res) => {
  try {
    const user_id = req.user.id;

    const { data: requests, error } = await supabaseAdmin
      .from('document_requests')
      .select(`
        *,
        share_link:share_links(
          share_token,
          file_id,
          expires_at,
          current_opens,
          max_opens
        )
      `)
      .eq('requester_id', user_id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching requests:', error);
      return res.status(500).json({ error: 'Failed to fetch requests' });
    }

    // Auto-expire old requests
    const expiredRequests = requests.filter(
      r => r.status === 'pending' && r.upload_deadline && new Date(r.upload_deadline) < new Date()
    );

    if (expiredRequests.length > 0) {
      await Promise.all(
        expiredRequests.map(r =>
          supabaseAdmin
            .from('document_requests')
            .update({ status: 'expired' })
            .eq('id', r.id)
        )
      );

      // Update status in response
      expiredRequests.forEach(r => r.status = 'expired');
    }

    res.json({ requests });

  } catch (error) {
    console.error('Error in my requests:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get requests sent to user (as recipient)
router.get('/my/received', jsonParser, authMiddleware, async (req, res) => {
  try {
    const user_id = req.user.id;

    // Get user email
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('email')
      .eq('id', user_id)
      .single();

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { data: requests, error } = await supabaseAdmin
      .from('document_requests')
      .select(`
        *,
        requester:users!requester_id(email)
      `)
      .eq('recipient_email', user.email)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching received requests:', error);
      return res.status(500).json({ error: 'Failed to fetch requests' });
    }

    res.json({ requests });

  } catch (error) {
    console.error('Error in received requests:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Cancel request
router.delete('/:id/cancel', jsonParser, authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const user_id = req.user.id;

    // Verify ownership
    const { data: request, error: fetchError } = await supabaseAdmin
      .from('document_requests')
      .select('*')
      .eq('id', id)
      .eq('requester_id', user_id)
      .single();

    if (fetchError || !request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Can only cancel pending requests' });
    }

    // Update status to cancelled
    const { error: updateError } = await supabaseAdmin
      .from('document_requests')
      .update({ status: 'cancelled' })
      .eq('id', id);

    if (updateError) {
      console.error('Error cancelling request:', updateError);
      return res.status(500).json({ error: 'Failed to cancel request' });
    }

    res.json({ success: true, message: 'Request cancelled' });

  } catch (error) {
    console.error('Error cancelling request:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

