import express from 'express';
import { supabaseAdmin } from '../../config/supabase.js';
import { authMiddleware } from '../middleware/auth.js';
import { shareLimiter } from '../middleware/rateLimiter.js';
import { sendDocumentRequestEmail, sendRequestFulfilledEmail } from '../utils/email.js';
import crypto from 'crypto';

const router = express.Router();

// Generate unique request token
const generateRequestToken = () => {
  return crypto.randomBytes(16).toString('hex');
};

// Create new document request (Free users: 3 lifetime, Pro users: unlimited)
router.post('/create', authMiddleware, shareLimiter, async (req, res) => {
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
    try {
      const requesterName = user.email.split('@')[0]; // Use email username as name
      await sendDocumentRequestEmail(
        recipient_email,
        requesterName,
        request_message,
        request_token,
        upload_deadline
      );
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

// Fulfill request with document upload
router.post('/:token/fulfill', authMiddleware, async (req, res) => {
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
          shareLink.share_token
        );
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
router.get('/my/requests', authMiddleware, async (req, res) => {
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
router.get('/my/received', authMiddleware, async (req, res) => {
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
router.delete('/:id/cancel', authMiddleware, async (req, res) => {
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

