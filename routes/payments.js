const express = require('express');
const { pool } = require('../config/database');
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

    // Check if user already has a Dodo customer ID
    const userResult = await pool.query(
      'SELECT dodo_customer_id FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    let customerId = userResult.rows[0].dodo_customer_id;

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

        // Save customer ID to database
        await pool.query(
          'UPDATE users SET dodo_customer_id = $1 WHERE id = $2',
          [customerId, userId]
        );
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
          // Update user to paid plan
          await pool.query(
            'UPDATE users SET plan_type = $1 WHERE id = $2',
            ['paid', userId]
          );
          
          console.log(`✅ User ${userId} upgraded to Pro plan via Dodo Payments`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        // Find user by customer ID and downgrade to free
        const userResult = await pool.query(
          'SELECT id FROM users WHERE dodo_customer_id = $1',
          [customerId]
        );

        if (userResult.rows.length > 0) {
          const userId = userResult.rows[0].id;
          await pool.query(
            'UPDATE users SET plan_type = $1 WHERE id = $2',
            ['free', userId]
          );
          
          console.log(`📉 User ${userId} downgraded to Free plan`);
        }
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
