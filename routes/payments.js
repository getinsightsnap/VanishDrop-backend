const express = require('express');
const { supabase } = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { dodoPayments } = require('../utils/dodoPayments');

const router = express.Router();

// Create checkout session using Dodo Payments
router.post('/create-checkout', requireAuth, async (req, res) => {
  try {
    const { userId, email } = req.body;
    
    // Validate user ID matches authenticated user
    if (userId !== req.userId) {
      return res.status(403).json({
        error: 'Unauthorized',
        code: 'UNAUTHORIZED'
      });
    }

    // Check if user exists in Supabase Auth
    const { data: userData, error: userError } = await supabase.auth.admin.getUserById(userId);
    
    if (userError || !userData.user) {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    // Get user metadata for Dodo customer ID
    let customerId = userData.user.user_metadata?.dodo_customer_id;

    // Create Dodo Payments customer if doesn't exist
    if (!customerId) {
      try {
        const customer = await dodoPayments.createCustomer({
          email,
          metadata: {
            userId,
            source: 'vanishdrop'
          },
        });

        customerId = customer.id;

        // Save customer ID to user metadata
        const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
          user_metadata: {
            ...userData.user.user_metadata,
            dodo_customer_id: customerId
          }
        });

        if (updateError) {
          console.error('Failed to save customer ID:', updateError);
        }
      } catch (customerError) {
        console.error('Failed to create Dodo customer:', customerError);
        return res.status(500).json({
          error: 'Failed to create customer account',
          code: 'CUSTOMER_CREATION_ERROR'
        });
      }
    }

    // Create Dodo Payments checkout session
    try {
      const session = await dodoPayments.createCheckoutSession({
        customer: customerId,
        mode: 'subscription',
        items: [
          {
            price: {
              currency: 'usd',
              product: {
                name: 'VanishDrop Pro',
                description: '10GB uploads, password protection, OTP generation, advanced features',
              },
              unit_amount: 899, // $8.99
              interval: 'month',
            },
            quantity: 1,
          },
        ],
        success_url: `${process.env.FRONTEND_URL}/dashboard?upgraded=true`,
        cancel_url: `${process.env.FRONTEND_URL}/upgrade`,
        metadata: {
          userId,
          plan: 'pro'
        },
      });

      res.json({ 
        sessionId: session.id,
        checkoutUrl: session.url,
        message: 'Dodo Payments checkout session created successfully'
      });
    } catch (sessionError) {
      console.error('Failed to create Dodo checkout session:', sessionError);
      return res.status(500).json({
        error: 'Failed to create checkout session',
        code: 'CHECKOUT_SESSION_ERROR'
      });
    }
  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      code: 'CHECKOUT_ERROR'
    });
  }
});

// Dodo Payments webhook handler
router.post('/webhook/dodo', async (req, res) => {
  try {
    const rawBody = JSON.stringify(req.body);
    const signature = req.headers['dodo-signature'];
    const timestamp = req.headers['dodo-timestamp'];

    // Verify webhook signature
    if (!dodoPayments.verifyWebhookSignature(rawBody, signature, timestamp)) {
      console.error('❌ Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = req.body;

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.userId;

        if (userId) {
          // Update user metadata to paid plan
          const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
            user_metadata: {
              tier: 'pro',
              plan_type: 'paid'
            }
          });

          if (updateError) {
            console.error('Failed to update user tier:', updateError);
          } else {
            console.log(`✅ User ${userId} upgraded to Pro plan via Dodo Payments`);
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        // Note: For subscription deletion, we would need to track customer IDs
        // in a separate table or use a different approach since Supabase Auth
        // doesn't have a direct way to query by user_metadata
        console.log(`📉 Subscription deleted for customer: ${customerId}`);
        console.log('Note: Manual user downgrade may be required');
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        
        // Log successful payment
        console.log(`💰 Dodo payment succeeded for customer ${customerId}`);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        
        // Handle failed payment - could downgrade user after grace period
        console.log(`❌ Dodo payment failed for customer ${customerId}`);
        break;
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Dodo webhook error:', error);
    res.status(400).json({ 
      error: 'Webhook error',
      code: 'WEBHOOK_ERROR'
    });
  }
});

// Get user's subscription status
router.get('/subscription', requireAuth, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT plan_type, dodo_customer_id, created_at FROM users WHERE id = $1',
      [req.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    const user = userResult.rows[0];
    
    res.json({
      subscription: {
        plan: user.plan_type,
        customerId: user.dodo_customer_id,
        memberSince: user.created_at,
        status: user.plan_type === 'paid' ? 'active' : 'free',
        provider: 'dodo'
      }
    });
  } catch (error) {
    console.error('Get subscription error:', error);
    res.status(500).json({
      error: 'Failed to get subscription',
      code: 'SUBSCRIPTION_ERROR'
    });
  }
});

module.exports = router;
