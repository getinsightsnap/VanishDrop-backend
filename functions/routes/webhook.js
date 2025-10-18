import express from 'express';
import { supabaseAdmin } from '../../config/supabase.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Health check endpoint
router.get('/dodo', (req, res) => {
  res.json({ 
    message: 'Webhook endpoint is accessible',
    timestamp: new Date().toISOString(),
    status: 'healthy'
  });
});

// Simple API key test
router.get('/dodo/apikey', (req, res) => {
  res.json({
    hasApiKey: !!process.env.DODO_PAYMENTS_API_KEY,
    apiKeyLength: process.env.DODO_PAYMENTS_API_KEY?.length,
    apiKeyPreview: process.env.DODO_PAYMENTS_API_KEY?.substring(0, 10) + '...'
  });
});

// Test Dodo Payments API key
router.get('/dodo/test', async (req, res) => {
  try {
    const testResponse = await fetch('https://api.dodopayments.com/v1/products', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.DODO_PAYMENTS_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    res.json({
      status: testResponse.status,
      ok: testResponse.ok,
      hasApiKey: !!process.env.DODO_PAYMENTS_API_KEY,
      apiKeyLength: process.env.DODO_PAYMENTS_API_KEY?.length
    });
  } catch (error) {
    res.json({
      error: error.message,
      hasApiKey: !!process.env.DODO_PAYMENTS_API_KEY,
      apiKeyLength: process.env.DODO_PAYMENTS_API_KEY?.length
    });
  }
});

// Create Dodo Payments checkout session with proper metadata
router.post('/dodo/create-checkout', async (req, res) => {
  try {
    logger.info('Checkout endpoint hit', { 
      body: req.body, 
      hasApiKey: !!process.env.DODO_PAYMENTS_API_KEY,
      apiKeyLength: process.env.DODO_PAYMENTS_API_KEY?.length 
    });
    
    const { userId, userEmail, redirectUrl } = req.body;
    
    if (!userId || !userEmail) {
      logger.error('Missing userId or userEmail', { userId, userEmail });
      return res.status(400).json({ error: 'userId and userEmail are required' });
    }
    
    logger.info('Creating checkout session', { userId, userEmail });
    
    // Create checkout session with Dodo Payments API - using correct format
    const checkoutData = {
      product_cart: [
        {
          product_id: 'pdt_KpH25grhUybj56ZBcu1hd',
          quantity: 1
        }
      ],
      customer_email: userEmail,
      success_url: redirectUrl || 'https://vanishdrop.com/payment/success',
      cancel_url: 'https://vanishdrop.com/pricing',
      metadata: {
        user_id: userId,
        source: 'vanishdrop_webapp'
      }
    };
    
    // Call Dodo Payments API to create checkout session
    logger.info('Calling Dodo Payments API', { 
      checkoutData,
      apiUrl: 'https://live.dodopayments.com/checkouts'
    });
    
    const dodoResponse = await fetch('https://live.dodopayments.com/checkouts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DODO_PAYMENTS_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(checkoutData)
    });
    
    logger.info('Dodo Payments API response received', { 
      status: dodoResponse.status,
      statusText: dodoResponse.statusText,
      ok: dodoResponse.ok
    });
    
    if (!dodoResponse.ok) {
      const errorText = await dodoResponse.text();
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { raw: errorText };
      }
      logger.error('Dodo Payments API error', { 
        status: dodoResponse.status,
        statusText: dodoResponse.statusText,
        error: errorData, 
        userId, 
        userEmail,
        headers: Object.fromEntries(dodoResponse.headers.entries())
      });
      throw new Error(`Dodo Payments API error (${dodoResponse.status}): ${errorData.message || errorData.error || errorText || 'Unknown error'}`);
    }
    
    const checkoutSession = await dodoResponse.json();
    
    logger.info('Checkout session created successfully', { 
      sessionId: checkoutSession.id, 
      userId, 
      userEmail 
    });
    
    res.json({
      success: true,
      checkoutUrl: checkoutSession.url,
      sessionId: checkoutSession.id
    });
    
  } catch (error) {
    logger.error('Failed to create checkout session', { 
      error: error.message,
      errorStack: error.stack,
      errorName: error.name,
      body: req.body,
      hasApiKey: !!process.env.DODO_PAYMENTS_API_KEY
    });
    
    res.status(500).json({ 
      error: 'Failed to create checkout session', 
      message: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Dodo Payments Webhook Handler
// Docs: https://docs.dodopayments.com/developer-resources/webhooks
router.post('/dodo', async (req, res) => {
  try {
    logger.info('Dodo Payments webhook received', { 
      headers: req.headers,
      body: req.body,
      method: req.method,
      url: req.url
    });

    // Verify webhook signature for security
    const webhookSignature = req.headers['webhook-signature'] || req.headers['x-dodo-signature'] || req.headers['dodo-signature'];
    const webhookId = req.headers['webhook-id'] || req.headers['x-webhook-id'];
    const webhookTimestamp = req.headers['webhook-timestamp'] || req.headers['x-webhook-timestamp'];
    const webhookSecret = process.env.DODO_PAYMENTS_WEBHOOK_SECRET;
    
    if (webhookSecret && webhookSignature && webhookId && webhookTimestamp) {
      try {
        // Import crypto for signature verification
        const crypto = await import('crypto');
        
        // Create the signature string
        const payload = JSON.stringify(req.body);
        const signatureString = `${webhookId}.${webhookTimestamp}.${payload}`;
        
        // Compute HMAC SHA256 signature
        const computedSignature = crypto
          .createHmac('sha256', webhookSecret)
          .update(signatureString)
          .digest('hex');
        
        // Compare signatures
        if (computedSignature !== webhookSignature) {
          logger.error('Webhook signature verification failed', {
            computed: computedSignature,
            received: webhookSignature,
            webhookId,
            webhookTimestamp
          });
          return res.status(401).json({ error: 'Invalid webhook signature' });
        }
        
        logger.info('Webhook signature verified successfully');
      } catch (signatureError) {
        logger.error('Error verifying webhook signature', { error: signatureError.message });
        return res.status(401).json({ error: 'Webhook signature verification failed' });
      }
    } else {
      logger.warn('Webhook signature verification skipped', {
        hasSecret: !!webhookSecret,
        hasSignature: !!webhookSignature,
        hasId: !!webhookId,
        hasTimestamp: !!webhookTimestamp
      });
    }

    // Handle different webhook events
    const eventType = req.body.type || req.body.event_type || req.body.event?.type;
    
    if (!eventType) {
      logger.error('No event type found in webhook payload', { body: req.body });
      return res.status(400).json({ error: 'No event type found in payload' });
    }
    
    logger.info('Processing webhook event', { eventType, body: req.body });
    
    switch (eventType) {
      case 'payment.succeeded':
      case 'subscription.active':
      case 'subscription.activated':
      case 'subscription.renewed':
        await handlePaymentSuccess(req, res);
        break;

      case 'payment.failed':
      case 'payment.cancelled':
        await handlePaymentFailure(req, res);
        break;

      case 'subscription.cancelled':
      case 'subscription.expired':
      case 'subscription.paused':
        await handleSubscriptionCancellation(req, res);
        break;

      case 'subscription.on_hold':
      case 'subscription.suspended':
        await handleSubscriptionHold(req, res);
        break;

      case 'subscription.trial_started':
      case 'subscription.trial_ended':
        await handleTrialEvent(req, res);
        break;

      case 'invoice.payment_failed':
      case 'invoice.payment_succeeded':
        await handleInvoiceEvent(req, res);
        break;

      default:
        logger.info('Unhandled webhook event', { eventType, body: req.body });
        res.json({ success: true, message: `Unhandled event: ${eventType}` });
    }

  } catch (error) {
    logger.error('Webhook processing failed', { 
      error: error.message, 
      stack: error.stack,
      body: req.body 
    });
    
    res.status(500).json({ 
      error: 'Internal server error', 
      message: error.message 
    });
  }
});

// Handle successful payments and subscription activation/renewal
async function handlePaymentSuccess(req, res) {
  try {
    const customerData = req.body.data?.customer || req.body.customer || req.body.data;
    const customerId = customerData?.customer_id || customerData?.id;
    const customerEmail = customerData?.email;
    const metadata = req.body.data?.metadata || req.body.metadata || {};
    const userId = metadata.user_id;
    const eventType = req.body.type || req.body.event_type;
    
    logger.info('Processing payment success', { 
      customerId, 
      customerEmail, 
      userId, 
      eventType
    });
    
    // Check if we have user_id in metadata (preferred method)
    if (userId) {
      logger.info('Found user_id in metadata, upgrading signed-in user', { userId });
      
      const { error: updateError } = await supabaseAdmin
        .from('users')
        .update({
          subscription_tier: 'pro',
          upgraded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId);

      if (updateError) {
        logger.error('Failed to update signed-in user subscription', { error: updateError, userId });
        throw updateError;
      }

      logger.info('Successfully upgraded signed-in user to Pro', { userId, eventType });
      res.json({ success: true, message: `Signed-in user ${userId} upgraded to Pro (${eventType})` });
      return;
    }
    
    // Fallback: Find user by email if no user_id in metadata
    if (customerEmail) {
      logger.info('No user_id in metadata, trying to find user by email', { customerEmail });
      
      const { data: userData, error: userError } = await supabaseAdmin
        .from('users')
        .select('id, email')
        .ilike('email', customerEmail)
        .single();
        
      if (userError || !userData) {
        // Try exact match as fallback
        const { data: exactUserData, error: exactUserError } = await supabaseAdmin
          .from('users')
          .select('id, email')
          .eq('email', customerEmail)
          .single();
          
        if (exactUserError || !exactUserData) {
          logger.warn('User not found in database for webhook', { 
            email: customerEmail, 
            eventType,
            customerId,
            suggestion: 'User may have entered different email in checkout'
          });
          
          res.json({ 
            success: true, 
            message: `Webhook processed but user not found: ${customerEmail}`,
            warning: 'User not found in database'
          });
          return;
        }
        
        // Use exact match result
        const foundUserId = exactUserData.id;
        logger.info('Found user with exact email match', { foundUserId });
        
        const { error: updateError } = await supabaseAdmin
          .from('users')
          .update({
            subscription_tier: 'pro',
            upgraded_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', foundUserId);

        if (updateError) {
          logger.error('Failed to update user subscription', { error: updateError, userId: foundUserId });
          throw updateError;
        }

        logger.info('Successfully upgraded user to Pro', { userId: foundUserId, eventType });
        res.json({ success: true, message: `User ${foundUserId} upgraded to Pro (${eventType})` });
        return;
      }
      
      // Use case-insensitive match result
      const foundUserId = userData.id;
      logger.info('Found user with case-insensitive email match', { foundUserId });
      
      const { error: updateError } = await supabaseAdmin
        .from('users')
        .update({
          subscription_tier: 'pro',
          upgraded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', foundUserId);

      if (updateError) {
        logger.error('Failed to update user subscription', { error: updateError, userId: foundUserId });
        throw updateError;
      }

      logger.info('Successfully upgraded user to Pro', { userId: foundUserId, eventType });
      res.json({ success: true, message: `User ${foundUserId} upgraded to Pro (${eventType})` });
      return;
    }
    
    logger.warn('No user_id or customer email found in webhook', { body: req.body });
    res.json({ success: true, message: 'Webhook processed but no user information found' });
    
  } catch (error) {
    logger.error('Error handling payment success', { error: error.message, body: req.body });
    throw error;
  }
}

// Handle failed payments
async function handlePaymentFailure(req, res) {
  const eventType = req.body.type || req.body.event_type;
  const metadata = req.body.data?.metadata || req.body.metadata || {};
  const userId = metadata.user_id;
  
  logger.warn('Payment failed', { eventType, userId });
  res.json({ success: true, message: `Payment failed for user ${userId || 'unknown'}` });
}

// Handle subscription cancellation/expiration/pause
async function handleSubscriptionCancellation(req, res) {
  const eventType = req.body.type || req.body.event_type;
  const metadata = req.body.data?.metadata || req.body.metadata || {};
  const userId = metadata.user_id;
  
  if (userId) {
    await supabaseAdmin
      .from('users')
      .update({
        subscription_tier: 'free',
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId);
      
    logger.info('User downgraded to Free', { userId, eventType });
  }
  
  res.json({ success: true, message: `User ${userId || 'unknown'} downgraded to Free (${eventType})` });
}

// Handle subscription on hold/suspended
async function handleSubscriptionHold(req, res) {
  const eventType = req.body.type || req.body.event_type;
  const metadata = req.body.data?.metadata || req.body.metadata || {};
  const userId = metadata.user_id;
  
  if (userId) {
    await supabaseAdmin
      .from('users')
      .update({
        subscription_tier: 'free',
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId);
      
    logger.info('User downgraded due to subscription hold', { userId });
  }
  
  res.json({ success: true, message: `User ${userId || 'unknown'} subscription on hold` });
}

// Handle trial events
async function handleTrialEvent(req, res) {
  const eventType = req.body.type || req.body.event_type;
  const metadata = req.body.data?.metadata || req.body.metadata || {};
  const userId = metadata.user_id;
  
  if (userId) {
    if (eventType === 'subscription.trial_started') {
      await supabaseAdmin
        .from('users')
        .update({
          subscription_tier: 'pro',
          trial_used: true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId);
      
      logger.info('User started trial', { userId });
    } else if (eventType === 'subscription.trial_ended') {
      await supabaseAdmin
        .from('users')
        .update({
          subscription_tier: 'free',
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId);
      
      logger.info('User trial ended, downgraded to free', { userId });
    }
  }
  
  res.json({ success: true, message: `Trial event processed for user ${userId || 'unknown'}` });
}

// Handle invoice events
async function handleInvoiceEvent(req, res) {
  const eventType = req.body.type || req.body.event_type;
  const metadata = req.body.data?.metadata || req.body.metadata || {};
  const userId = metadata.user_id;
  
  if (userId && eventType === 'invoice.payment_failed') {
    logger.warn('Invoice payment failed for user', { userId });
  }
  
  res.json({ success: true, message: `Invoice event processed for user ${userId || 'unknown'}` });
}

export default router;
