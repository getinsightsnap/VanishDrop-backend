import express from 'express';
import { supabaseAdmin } from '../../config/supabase.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Test endpoint to verify webhook URL is accessible
router.get('/dodo', (req, res) => {
  res.json({ 
    message: 'Webhook endpoint is accessible',
    timestamp: new Date().toISOString(),
    method: 'GET'
  });
});

// Debug endpoint to test webhook processing with sample data
router.post('/dodo/debug', async (req, res) => {
  try {
    console.log('=== DEBUG WEBHOOK TEST ===');
    console.log('Test payload:', req.body);
    
    // Simulate a payment.succeeded event
    const testPayload = {
      type: 'payment.succeeded',
      data: {
        customer: {
          email: req.body.testEmail || 'test@example.com',
          customer_id: 'test_customer_123'
        },
        metadata: {
          user_id: req.body.testUserId || null
        }
      }
    };
    
    console.log('Simulating webhook with payload:', testPayload);
    
    // Process the test payload
    req.body = testPayload;
    
    // Call the main webhook handler
    await router.handle(req, res);
    
  } catch (error) {
    console.error('Debug webhook test error:', error);
    res.status(500).json({ 
      error: 'Debug test failed', 
      message: error.message 
    });
  }
});

// Dodo Payments Webhook Handler
// Docs: https://docs.dodopayments.com/developer-resources/webhooks
router.post('/dodo', async (req, res) => {
  try {
    console.log('=== WEBHOOK CALLED ===');
    console.log('Headers:', req.headers);
    console.log('Body:', req.body);
    console.log('Method:', req.method);
    console.log('URL:', req.url);
    console.log('========================');
    
    logger.info('Dodo Payments webhook received', { 
      headers: req.headers,
      body: req.body,
      method: req.method,
      url: req.url
    });

    // Verify webhook signature for security
    const webhookSignature = req.headers['webhook-signature'] || req.headers['x-dodo-signature'];
    const webhookId = req.headers['webhook-id'];
    const webhookTimestamp = req.headers['webhook-timestamp'];
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
          console.error('Webhook signature verification failed');
          logger.error('Webhook signature verification failed', {
            computed: computedSignature,
            received: webhookSignature,
            webhookId,
            webhookTimestamp
          });
          return res.status(401).json({ error: 'Invalid webhook signature' });
        }
        
        console.log('✅ Webhook signature verified successfully');
        logger.info('Webhook signature verified successfully');
      } catch (signatureError) {
        console.error('Error verifying webhook signature:', signatureError);
        logger.error('Error verifying webhook signature', { error: signatureError.message });
        return res.status(401).json({ error: 'Webhook signature verification failed' });
      }
    } else {
      console.warn('Webhook signature verification skipped - missing required headers or secret');
      logger.warn('Webhook signature verification skipped', {
        hasSecret: !!webhookSecret,
        hasSignature: !!webhookSignature,
        hasId: !!webhookId,
        hasTimestamp: !!webhookTimestamp
      });
    }

    // Handle different webhook events
    // Dodo Payments webhook structure can vary, check multiple possible locations
    const eventType = req.body.type || req.body.event_type || req.body.event?.type;
    
    console.log('Event type:', eventType);
    console.log('Full payload structure:', JSON.stringify(req.body, null, 2));
    console.log('Available keys in body:', Object.keys(req.body));
    
    if (!eventType) {
      console.error('No event type found in webhook payload');
      logger.error('No event type found in webhook payload', { body: req.body });
      return res.status(400).json({ error: 'No event type found in payload' });
    }
    
    switch (eventType) {
      case 'payment.succeeded':
      case 'subscription.active':
      case 'subscription.activated':
      case 'subscription.renewed':
        // Handle successful payments and subscription activation/renewal
        // Check multiple possible locations for customer data
        const customerData = req.body.data?.customer || req.body.customer || req.body.data;
        const customerId = customerData?.customer_id || customerData?.id;
        const customerEmail = customerData?.email;
        const metadata = req.body.data?.metadata || req.body.metadata || {};
        const userId = metadata.user_id;
        
        console.log('Processing payment success:', { 
          customerId, 
          customerEmail, 
          userId, 
          metadata, 
          eventType,
          fullData: req.body.data
        });
        
        // Since user_id is not in metadata, we need to find the user by email
        if (!userId && customerEmail) {
          console.log('No user_id in metadata, trying to find user by email:', customerEmail);
          
          try {
            // Find user by email (case-insensitive)
            const { data: userData, error: userError } = await supabaseAdmin
              .from('users')
              .select('id, email')
              .ilike('email', customerEmail) // Case-insensitive search
              .single();
              
            if (userError || !userData) {
              console.error('User not found by email:', customerEmail, 'Error:', userError);
              logger.error('User not found by email', { email: customerEmail, error: userError });
              
              // Try exact match as fallback
              const { data: exactUserData, error: exactUserError } = await supabaseAdmin
                .from('users')
                .select('id, email')
                .eq('email', customerEmail)
                .single();
                
              if (exactUserError || !exactUserData) {
                console.error('User not found with exact email match either:', customerEmail);
                return res.status(400).json({ 
                  error: 'User not found by email', 
                  email: customerEmail,
                  details: 'No user found with this email address'
                });
              }
              
              // Use exact match result
              const foundUserId = exactUserData.id;
              console.log('Found user with exact email match:', foundUserId);
              
              // Update user subscription to pro
              const { error: updateError } = await supabaseAdmin
                .from('users')
                .update({
                  subscription_tier: 'pro',
                  upgraded_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                })
                .eq('id', foundUserId);

              if (updateError) {
                console.error('Error updating user subscription:', updateError);
                logger.error('Failed to update user subscription', { error: updateError, userId: foundUserId });
                throw updateError;
              }

              console.log(`✅ Successfully upgraded user ${foundUserId} to Pro (${eventType})`);
              logger.info(`User upgraded to Pro`, { userId: foundUserId, eventType });
              
              res.json({ success: true, message: `User ${foundUserId} upgraded to Pro (${eventType})` });
              return;
            }
            
            // Use the found user ID (case-insensitive match worked)
            const foundUserId = userData.id;
            console.log('Found user by email (case-insensitive):', foundUserId);
            
            // Update user subscription to pro
            const { error: updateError } = await supabaseAdmin
              .from('users')
              .update({
                subscription_tier: 'pro',
                upgraded_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq('id', foundUserId);

            if (updateError) {
              console.error('Error updating user subscription:', updateError);
              logger.error('Failed to update user subscription', { error: updateError, userId: foundUserId });
              throw updateError;
            }

            console.log(`✅ Successfully upgraded user ${foundUserId} to Pro (${eventType})`);
            logger.info(`User upgraded to Pro`, { userId: foundUserId, eventType });
            
            res.json({ success: true, message: `User ${foundUserId} upgraded to Pro (${eventType})` });
            return;
            
          } catch (emailLookupError) {
            console.error('Error during email lookup:', emailLookupError);
            logger.error('Email lookup failed', { error: emailLookupError, email: customerEmail });
            return res.status(500).json({ 
              error: 'Failed to lookup user by email', 
              details: emailLookupError.message 
            });
          }
        }
        
        if (!userId) {
          console.error('No user_id in webhook metadata and no customer email');
          logger.error('Missing user_id in webhook metadata and no customer email', { body: req.body });
          return res.status(400).json({ error: 'Missing user_id in metadata and no customer email' });
        }

        // Update user subscription to pro
        const { error: updateError } = await supabaseAdmin
          .from('users')
          .update({
            subscription_tier: 'pro',
            upgraded_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', userId);

        if (updateError) {
          console.error('Error updating user subscription:', updateError);
          logger.error('Failed to update user subscription', { error: updateError, userId });
          throw updateError;
        }

        console.log(`✅ Successfully upgraded user ${userId} to Pro (${eventType})`);
        logger.info(`User upgraded to Pro`, { userId, eventType });
        
        res.json({ success: true, message: `User ${userId} upgraded to Pro (${eventType})` });
        break;

      case 'payment.failed':
      case 'payment.cancelled':
        // Handle failed payments
        const failedMetadata = req.body.data?.metadata || {};
        const failedUserId = failedMetadata.user_id;
        
        console.log('Processing payment failure:', { eventType, failedUserId });
        
        if (failedUserId) {
          // Log the payment failure but don't change subscription yet
          // User might retry payment
          logger.warn(`Payment failed for user`, { userId: failedUserId, eventType });
        }
        
        res.json({ success: true, message: `Payment failed for user ${failedUserId}` });
        break;

      case 'subscription.cancelled':
      case 'subscription.expired':
      case 'subscription.paused':
        // Handle subscription cancellation/expiration/pause
        const cancelMetadata = req.body.data?.metadata || {};
        const cancelUserId = cancelMetadata.user_id;
        
        console.log('Processing subscription cancellation:', { eventType, cancelUserId });
        
        if (cancelUserId) {
          await supabaseAdmin
            .from('users')
            .update({
              subscription_tier: 'free',
              updated_at: new Date().toISOString(),
            })
            .eq('id', cancelUserId);
            
          console.log(`Downgraded user ${cancelUserId} to Free (${eventType})`);
          logger.info(`User downgraded to Free`, { userId: cancelUserId, eventType });
        }
        
        res.json({ success: true, message: `User ${cancelUserId} downgraded to Free (${eventType})` });
        break;

      case 'subscription.on_hold':
      case 'subscription.suspended':
        // Handle subscription on hold/suspended
        const holdMetadata = req.body.data?.metadata || {};
        const holdUserId = holdMetadata.user_id;
        
        console.log('Processing subscription on hold:', { eventType, holdUserId });
        
        if (holdUserId) {
          // Option 1: Downgrade to free immediately
          await supabaseAdmin
            .from('users')
            .update({
              subscription_tier: 'free',
              updated_at: new Date().toISOString(),
            })
            .eq('id', holdUserId);
            
          console.log(`Downgraded user ${holdUserId} to Free (subscription on hold)`);
          logger.info(`User downgraded due to subscription hold`, { userId: holdUserId });
          
          // Option 2: Keep Pro but mark as on hold (alternative approach)
          // await supabaseAdmin
          //   .from('users')
          //   .update({
          //     subscription_status: 'on_hold',
          //     updated_at: new Date().toISOString(),
          //   })
          //   .eq('id', holdUserId);
        }
        
        res.json({ success: true, message: `User ${holdUserId} subscription on hold` });
        break;

      case 'subscription.trial_started':
      case 'subscription.trial_ended':
        // Handle trial events (if you implement trials)
        const trialMetadata = req.body.data?.metadata || {};
        const trialUserId = trialMetadata.user_id;
        
        console.log('Processing trial event:', { eventType, trialUserId });
        
        if (trialUserId) {
          if (eventType === 'subscription.trial_started') {
            // User started trial
            await supabaseAdmin
              .from('users')
              .update({
                subscription_tier: 'pro',
                trial_used: true,
                updated_at: new Date().toISOString(),
              })
              .eq('id', trialUserId);
            
            logger.info(`User started trial`, { userId: trialUserId });
          } else if (eventType === 'subscription.trial_ended') {
            // Trial ended - check if they have active subscription
            // If no active subscription, downgrade to free
            await supabaseAdmin
              .from('users')
              .update({
                subscription_tier: 'free',
                updated_at: new Date().toISOString(),
              })
              .eq('id', trialUserId);
            
            logger.info(`User trial ended, downgraded to free`, { userId: trialUserId });
          }
        }
        
        res.json({ success: true, message: `Trial event processed for user ${trialUserId}` });
        break;

      case 'invoice.payment_failed':
      case 'invoice.payment_succeeded':
        // Handle invoice events
        const invoiceMetadata = req.body.data?.metadata || {};
        const invoiceUserId = invoiceMetadata.user_id;
        
        console.log('Processing invoice event:', { eventType, invoiceUserId });
        
        if (invoiceUserId && eventType === 'invoice.payment_failed') {
          // Payment failed for recurring subscription
          // You might want to send notification email here
          logger.warn(`Invoice payment failed for user`, { userId: invoiceUserId });
        }
        
        res.json({ success: true, message: `Invoice event processed for user ${invoiceUserId}` });
        break;

      default:
        console.log(`Unhandled webhook event: ${eventType}`);
        logger.info(`Unhandled webhook event`, { eventType, body: req.body });
        res.json({ success: true, message: `Unhandled event: ${eventType}` });
    }

  } catch (error) {
    console.error('Webhook processing error:', error);
    logger.error('Webhook processing failed', { error: error.message, stack: error.stack });
    
    res.status(500).json({ 
      error: 'Internal server error', 
      message: error.message 
    });
  }
});

export default router;
