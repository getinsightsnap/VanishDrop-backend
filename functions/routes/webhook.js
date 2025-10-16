import express from 'express';
import { supabaseAdmin } from '../../config/supabase.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Dodo Payments Webhook Handler
// Docs: https://docs.dodopayments.com/developer-resources/webhooks
router.post('/dodo', async (req, res) => {
  try {
    console.log('Received Dodo Payments webhook:', req.body);
    logger.info('Dodo Payments webhook received', { body: req.body });

    // Handle different webhook events
    const eventType = req.body.event_type || req.body.type;
    
    switch (eventType) {
      case 'payment.succeeded':
      case 'subscription.active':
      case 'subscription.activated':
      case 'subscription.renewed':
        // Handle successful payments and subscription activation/renewal
        const customerId = req.body.data?.customer_id;
        const metadata = req.body.data?.metadata || {};
        const userId = metadata.user_id;
        
        console.log('Processing payment success:', { customerId, userId, metadata, eventType });
        
        if (!userId) {
          console.error('No user_id in webhook metadata');
          logger.error('Missing user_id in webhook metadata', { body: req.body });
          return res.status(400).json({ error: 'Missing user_id in metadata' });
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
