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
        // Extract customer and subscription data
        const customerId = req.body.data?.customer_id;
        const metadata = req.body.data?.metadata || {};
        const userId = metadata.user_id;
        
        console.log('Processing payment success:', { customerId, userId, metadata });
        
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

        console.log(`✅ Successfully upgraded user ${userId} to Pro`);
        logger.info(`User upgraded to Pro`, { userId });
        
        res.json({ success: true, message: `User ${userId} upgraded to Pro` });
        break;

      case 'subscription.cancelled':
      case 'subscription.expired':
        // Handle subscription cancellation
        const cancelUserId = req.body.data?.metadata?.user_id;
        
        if (cancelUserId) {
          await supabaseAdmin
            .from('users')
            .update({
              subscription_tier: 'free',
              updated_at: new Date().toISOString(),
            })
            .eq('id', cancelUserId);
            
          console.log(`Downgraded user ${cancelUserId} to Free`);
          logger.info(`User downgraded to Free`, { userId: cancelUserId });
        }
        
        res.json({ success: true, message: `User ${cancelUserId} downgraded to Free` });
        break;

      default:
        console.log(`Unhandled webhook event: ${eventType}`);
        logger.info(`Unhandled webhook event`, { eventType });
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
