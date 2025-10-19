import express from 'express';
import { supabaseAdmin } from '../../config/supabase.js';
import logger from '../utils/logger.js';
import DodoPayments from 'dodopayments';
import { Webhook } from 'standardwebhooks';

const router = express.Router();

// Initialize Dodo Payments client
const dodoClient = new DodoPayments({
  bearerToken: process.env.DODO_PAYMENTS_API_KEY,
});

// Initialize Webhook verifier with proper error handling
const webhookSecret = process.env.DODO_PAYMENTS_WEBHOOK_SECRET;
let webhookVerifier = null;

// Only initialize webhook verifier if we have a valid secret
// Dodo Payments follows Standard Webhooks specification
if (webhookSecret && 
    webhookSecret !== 'your_dodo_payments_webhook_secret_here' && 
    webhookSecret.startsWith('whsec_')) {
  try {
    // Remove whsec_ prefix for standardwebhooks library
    const cleanSecret = webhookSecret.substring(6); // Remove 'whsec_' (6 characters)
    webhookVerifier = new Webhook(cleanSecret);
    logger.info('✅ Webhook verifier initialized successfully');
  } catch (error) {
    logger.warn('⚠️ Invalid webhook secret format, webhook verification disabled:', error.message);
  }
} else {
  logger.warn('⚠️ No valid webhook secret configured (must start with whsec_), webhook verification disabled');
}

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

// Create Dodo Payments subscription checkout using official SDK pattern
// This route needs express.json() to parse the request body
router.post('/dodo/create-checkout', express.json(), async (req, res) => {
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
    
    logger.info('Creating subscription checkout session', { userId, userEmail });
    
    // For subscriptions, use SDK with payment_link: true (following official pattern)
    const productId = 'pdt_KpH25grhUybj56ZBcu1hd';
    
    // Extract billing info and discount code from request (optional from frontend)
    const { billingInfo, discountCode } = req.body;
    
    // Dodo Payments requires billing field for subscriptions
    // Use provided info or defaults that user can update on checkout page
    const billing = billingInfo || {
      city: "",  // User will update on checkout page
      country: "US",  // Default, user can change
      state: "",
      street: "",
      zipcode: ""
    };
    
    logger.info('Creating subscription with SDK', { userId, userEmail, hasBillingInfo: !!billingInfo });
    
    // Create checkout session with discount code support using Dodo Payments SDK
    const checkoutPayload = {
      product_cart: [
        { 
          product_id: productId, 
          quantity: 1 
        }
      ],
      feature_flags: {
        allow_discount_code: true // Enable coupon/discount code field on checkout
      },
      return_url: redirectUrl || 'https://vanishdrop.com/payment/success',
      customer: {
        email: userEmail,
        name: userEmail.split('@')[0], // Extract name from email
      },
      billing: billing,
      metadata: {
        user_id: userId,
        source: 'vanishdrop_webapp'
      }
    };
    
    // Add discount code if provided
    if (discountCode) {
      checkoutPayload.discount_code = discountCode;
      logger.info('Applying discount code', { discountCode });
    }
    
    const checkoutResponse = await dodoClient.checkoutSessions.create(checkoutPayload);
    
    logger.info('✅ Checkout session created', { 
      checkoutUrl: checkoutResponse.checkout_url,
      sessionId: checkoutResponse.session_id,
      userId, 
      userEmail 
    });
    
    res.json({
      success: true,
      checkoutUrl: checkoutResponse.checkout_url,
      sessionId: checkoutResponse.session_id
    });
    
  } catch (error) {
    logger.error('❌ Failed to create subscription checkout', { 
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

// Dodo Payments Webhook Handler (Following official pattern)
// Docs: https://docs.dodopayments.com/developer-resources/webhooks
router.post('/dodo', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // Get raw body for verification
    const rawBody = req.body.toString('utf8');
    
    logger.info('📨 Dodo Payments webhook received', { 
      headers: req.headers,
      bodyPreview: rawBody.substring(0, 200),
      method: req.method,
      url: req.url
    });

    // Verify webhook signature using Standard Webhooks library
    // Dodo Payments follows the Standard Webhooks specification
    const webhookId = req.headers['webhook-id'] || '';
    const signature = req.headers['webhook-signature'] || '';
    const timestamp = req.headers['webhook-timestamp'] || '';
    
    logger.info('🔍 Attempting webhook verification', {
      webhookId,
      hasSignature: !!signature,
      timestamp,
      bodyLength: rawBody.length
    });
    
    if (webhookVerifier) {
      try {
        // Construct webhook headers as required by Standard Webhooks
        const webhookHeaders = {
          'webhook-id': webhookId,
          'webhook-signature': signature,
          'webhook-timestamp': timestamp
        };
        
        // Verify the webhook using the Standard Webhooks library
        // This follows Dodo Payments specification: webhook-id.webhook-timestamp.payload
        await webhookVerifier.verify(rawBody, webhookHeaders);
        logger.info('✅ Webhook signature verified successfully - webhook is from Dodo Payments');
      } catch (verificationError) {
        logger.error('❌ Webhook verification failed', { 
          error: verificationError.message,
          webhookId,
          timestamp,
          bodyLength: rawBody.length
        });
        return res.status(401).json({ 
          error: 'Webhook verification failed',
          message: verificationError.message
        });
      }
    } else {
      logger.warn('⚠️ Webhook verification skipped - no valid webhook secret configured');
    }
    
    // Parse the verified payload
    const payload = JSON.parse(rawBody);
    
    // Extract event information
    const eventType = payload.type;
    const payloadType = payload.data?.payload_type; // 'Subscription' or 'Payment'
    
    if (!eventType) {
      logger.error('No event type found in webhook payload', { payload });
      return res.status(400).json({ error: 'No event type found in payload' });
    }
    
    logger.info('📨 Processing Dodo Payments webhook event', { 
      eventType, 
      payloadType,
      subscriptionId: payload.data?.subscription_id,
      paymentId: payload.data?.payment_id
    });
    
    // Handle events based on payload type (official pattern)
    if (payloadType === 'Subscription') {
      // Retrieve full subscription data
      const subscriptionId = payload.data?.subscription_id;
      let subscriptionData = null;
      
      if (subscriptionId) {
        try {
          subscriptionData = await dodoClient.subscriptions.retrieve(subscriptionId);
          logger.info('📋 Retrieved full subscription data', { 
            subscriptionId,
            status: subscriptionData.status,
            customer: subscriptionData.customer_email
          });
        } catch (error) {
          logger.warn('⚠️ Failed to retrieve subscription data', { error: error.message });
        }
      }
      
      // Handle Subscription Events
      switch (eventType) {
        case 'subscription.active':
        case 'subscription.activated':
          logger.info('🎉 Subscription activated - user upgraded to Pro');
          await handleSubscriptionActivated(payload, subscriptionData, res);
          break;
        
        case 'subscription.renewed':
          logger.info('🔄 Subscription renewed - recurring payment processed');
          await handleSubscriptionRenewed(payload, subscriptionData, res);
          break;

        case 'subscription.cancelled':
          logger.warn('🚫 Subscription cancelled');
          await handleSubscriptionCancellation(payload, subscriptionData, res);
          break;
        
        case 'subscription.expired':
          logger.warn('⏰ Subscription expired');
          await handleSubscriptionCancellation(payload, subscriptionData, res);
          break;
        
        case 'subscription.paused':
          logger.warn('⏸️ Subscription paused');
          await handleSubscriptionCancellation(payload, subscriptionData, res);
          break;

        case 'subscription.on_hold':
        case 'subscription.suspended':
        case 'subscription.failed':
          logger.warn('⚠️ Subscription on hold/suspended/failed');
          await handleSubscriptionHold(payload, subscriptionData, res);
          break;

        case 'subscription.trial_started':
        case 'subscription.trial_ended':
          logger.info('🎁 Trial event:', eventType);
          await handleTrialEvent(payload, subscriptionData, res);
          break;

        default:
          logger.info('❓ Unhandled subscription event', { eventType });
          res.json({ success: true, message: `Subscription event received: ${eventType}` });
      }
    } else if (payloadType === 'Payment') {
      // Handle Payment Events (one-time payments)
      const paymentId = payload.data?.payment_id;
      let paymentData = null;
      
      if (paymentId) {
        try {
          paymentData = await dodoClient.payments.retrieve(paymentId);
          logger.info('📋 Retrieved full payment data', { 
            paymentId,
            status: paymentData.status
          });
        } catch (error) {
          logger.warn('⚠️ Failed to retrieve payment data', { error: error.message });
        }
      }
      
      switch (eventType) {
        case 'payment.succeeded':
          logger.info('💰 One-time payment succeeded');
          await handlePaymentSuccess(payload, paymentData, res);
          break;
        
        case 'payment.failed':
        case 'payment.cancelled':
          logger.warn('⚠️ Payment failed or cancelled');
          await handlePaymentFailure(payload, paymentData, res);
          break;
        
        default:
          logger.info('❓ Unhandled payment event', { eventType });
          res.json({ success: true, message: `Payment event received: ${eventType}` });
      }
    } else {
      // Handle other event types (invoices, etc.)
      logger.info('❓ Unhandled payload type', { payloadType, eventType });
      res.json({ success: true, message: `Webhook received: ${eventType}` });
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

// Handle subscription activation (first payment or reactivation)
async function handleSubscriptionActivated(payload, subscriptionData, res) {
  try {
    const metadata = subscriptionData?.metadata || payload.data?.metadata || {};
    const userId = metadata.user_id;
    const customerEmail = subscriptionData?.customer_email || payload.data?.customer?.email;
    const eventType = payload.type;
    
    logger.info('💳 Processing subscription activation', { 
      customerEmail, 
      userId, 
      eventType,
      subscriptionId: subscriptionData?.subscription_id
    });
    
    // Check if we have user_id in metadata (preferred method)
    if (userId) {
      logger.info('✅ Found user_id in metadata, activating subscription for user', { userId });
      
      const { error: updateError } = await supabaseAdmin
        .from('users')
        .update({
          subscription_tier: 'pro',
          upgraded_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId);

      if (updateError) {
        logger.error('❌ Failed to activate subscription for user', { error: updateError, userId });
        throw updateError;
      }

      logger.info('🎉 Successfully activated Pro subscription for user', { userId, eventType });
      res.json({ success: true, message: `User ${userId} subscription activated - upgraded to Pro (${eventType})` });
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
    logger.error('Error handling subscription activation', { error: error.message, payload });
    throw error;
  }
}

// Handle subscription renewal (recurring payment)
async function handleSubscriptionRenewed(payload, subscriptionData, res) {
  try {
    const metadata = subscriptionData?.metadata || payload.data?.metadata || {};
    const userId = metadata.user_id;
    const customerEmail = subscriptionData?.customer_email || payload.data?.customer?.email;
    const eventType = payload.type;
    
    logger.info('🔄 Processing subscription renewal', { 
      customerEmail, 
      userId, 
      eventType
    });
    
    // Check if we have user_id in metadata
    if (userId) {
      logger.info('✅ Found user_id in metadata, renewing subscription for user', { userId });
      
      // User should already be Pro, but ensure they remain Pro after renewal
      const { error: updateError } = await supabaseAdmin
        .from('users')
        .update({
          subscription_tier: 'pro',
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId);

      if (updateError) {
        logger.error('❌ Failed to renew subscription for user', { error: updateError, userId });
        throw updateError;
      }

      logger.info('🎉 Successfully renewed Pro subscription for user', { userId, eventType });
      res.json({ success: true, message: `User ${userId} subscription renewed - remains Pro (${eventType})` });
      return;
    }
    
    // Fallback: Find user by email
    if (customerEmail) {
      logger.info('No user_id in metadata, finding user by email for renewal', { customerEmail });
      
      const { data: userData, error: userError } = await supabaseAdmin
        .from('users')
        .select('id, email')
        .ilike('email', customerEmail)
        .single();
        
      if (!userError && userData) {
        const foundUserId = userData.id;
        
        const { error: updateError } = await supabaseAdmin
          .from('users')
          .update({
            subscription_tier: 'pro',
            updated_at: new Date().toISOString(),
          })
          .eq('id', foundUserId);

        if (updateError) {
          logger.error('❌ Failed to renew subscription', { error: updateError, userId: foundUserId });
          throw updateError;
        }

        logger.info('🎉 Successfully renewed subscription', { userId: foundUserId, eventType });
        res.json({ success: true, message: `User ${foundUserId} subscription renewed (${eventType})` });
        return;
      }
    }
    
    logger.warn('⚠️ User not found for subscription renewal', { customerEmail, userId });
    res.json({ success: true, message: 'Subscription renewal processed but user not found' });
    
  } catch (error) {
    logger.error('Error handling subscription renewal', { error: error.message, payload });
    throw error;
  }
}

// Handle payment success (one-time payments)
async function handlePaymentSuccess(payload, paymentData, res) {
  const eventType = payload.type;
  const metadata = paymentData?.metadata || payload.data?.metadata || {};
  const userId = metadata.user_id;
  
  logger.info('💰 One-time payment succeeded', { eventType, userId });
  res.json({ success: true, message: `One-time payment succeeded for user ${userId || 'unknown'}` });
}

// Handle failed payments
async function handlePaymentFailure(payload, paymentData, res) {
  const eventType = payload.type;
  const metadata = paymentData?.metadata || payload.data?.metadata || {};
  const userId = metadata.user_id;
  
  logger.warn('Payment failed', { eventType, userId });
  res.json({ success: true, message: `Payment failed for user ${userId || 'unknown'}` });
}

// Handle subscription cancellation/expiration/pause
async function handleSubscriptionCancellation(payload, subscriptionData, res) {
  const eventType = payload.type;
  const metadata = subscriptionData?.metadata || payload.data?.metadata || {};
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
async function handleSubscriptionHold(payload, subscriptionData, res) {
  const eventType = payload.type;
  const metadata = subscriptionData?.metadata || payload.data?.metadata || {};
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
async function handleTrialEvent(payload, subscriptionData, res) {
  const eventType = payload.type;
  const metadata = subscriptionData?.metadata || payload.data?.metadata || {};
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
async function handleInvoiceEvent(payload, invoiceData, res) {
  const eventType = payload.type;
  const metadata = payload.data?.metadata || {};
  const userId = metadata.user_id;
  
  if (userId && eventType === 'invoice.payment_failed') {
    logger.warn('Invoice payment failed for user', { userId });
  }
  
  res.json({ success: true, message: `Invoice event processed for user ${userId || 'unknown'}` });
}

export default router;
