# Webhook Metadata Issue & Solution

## 🔍 Problem Identified

The Dodo Payments webhook is receiving payments/subscriptions successfully, but the `metadata` field is empty:

```json
{
  "metadata": {},  // ← Should contain { "user_id": "uuid", "source": "vanishdrop_webapp" }
  "customer": {
    "email": "user@example.com"  // ← This IS coming through
  }
}
```

## 🎯 Root Cause

The checkout session creation code **is** sending metadata correctly:

```javascript
const checkoutPayload = {
  product_cart: [
    { 
      product_id: productId, 
      quantity: 1,
      metadata: { user_id: userId, source: 'vanishdrop_webapp' }  // Added at product level
    }
  ],
  metadata: {
    user_id: userId,
    source: 'vanishdrop_webapp'  // Added at session level
  }
};
```

However, Dodo Payments is not passing this metadata through to the webhook payload for subscriptions.

### Possible Reasons:
1. **Dodo Payments SDK limitation** - Metadata might not be supported for subscription products
2. **API version issue** - Older Dodo Payments API might not support metadata on subscriptions
3. **Product configuration** - The subscription product in Dodo Payments dashboard might need metadata enabled

## ✅ Solution Implemented: Email Fallback

Since the customer email **IS** being passed through successfully, the webhook now uses a two-tier approach:

### Tier 1: Try Metadata (Preferred)
```javascript
const userId = metadata.user_id;
if (userId) {
  // Directly upgrade user by ID
  await supabaseAdmin.from('users').update({ 
    subscription_tier: 'pro' 
  }).eq('id', userId);
}
```

### Tier 2: Email Fallback (Current Working Method)
```javascript
const customerEmail = payload.data?.customer?.email;
if (customerEmail) {
  // Find user by email
  const { data: userData } = await supabaseAdmin
    .from('users')
    .select('id, email')
    .ilike('email', customerEmail)
    .single();
  
  // Upgrade user
  await supabaseAdmin.from('users').update({ 
    subscription_tier: 'pro' 
  }).eq('id', userData.id);
}
```

## 📊 Current Status

| Component | Status | Notes |
|-----------|--------|-------|
| Checkout creation | ✅ Working | Sends userId and userEmail |
| Webhook reception | ✅ Working | Receives events from Dodo |
| Signature verification | ✅ Working | Using Standard Webhooks library |
| Metadata passing | ⚠️ Not working | Empty in webhook payload |
| Email passing | ✅ Working | Customer email comes through |
| User upgrade (via email) | ✅ Working | Fallback method active |

## 🚀 What Happens Now

When a user pays for Pro:

1. **Frontend** → Creates checkout with userId and userEmail
2. **Dodo Payments** → Processes payment
3. **Webhook received** → Dodo sends event to backend
4. **Signature verified** → Webhook is authentic
5. **Metadata check** → Empty, so skip to fallback
6. **Email lookup** → Find user in database by email
7. **User upgraded** → Set subscription_tier = 'pro' ✅

## 📝 Monitoring & Logs

Enhanced logging has been added to track the metadata issue:

```
💳 Processing subscription activation
  customerEmail: user@example.com
  userId: undefined
  metadata: {}
  hasMetadata: true
  metadataKeys: []
  
⚠️ No user_id found in metadata - using email fallback method
  customerEmail: user@example.com
  
✅ Found user by email
  userId: abc-123-uuid
  
🎉 Successfully activated Pro subscription for user
```

## 🔧 Future Improvements

### Option 1: Contact Dodo Payments Support
Ask if metadata is supported for subscription products and how to enable it.

### Option 2: Use Checkout Session ID
Store the checkout session ID in your database when created, then match it in the webhook:

```javascript
// During checkout
const sessionId = checkoutResponse.session_id;
await supabaseAdmin.from('pending_checkouts').insert({
  session_id: sessionId,
  user_id: userId,
  created_at: new Date()
});

// In webhook
const sessionId = payload.data.checkout_session_id;
const { data } = await supabaseAdmin
  .from('pending_checkouts')
  .select('user_id')
  .eq('session_id', sessionId)
  .single();
```

### Option 3: Pre-register Expected Payments
Before redirecting to checkout, create a pending upgrade record:

```javascript
// Before checkout
await supabaseAdmin.from('users').update({
  pending_upgrade: true,
  pending_upgrade_email: userEmail
}).eq('id', userId);

// In webhook
const email = payload.data.customer.email;
await supabaseAdmin.from('users').update({
  subscription_tier: 'pro',
  pending_upgrade: false
}).eq('pending_upgrade_email', email);
```

## ✅ Conclusion

**The payment system is now functional** using the email fallback method. Users will be upgraded to Pro successfully after payment, even though metadata isn't being passed through.

The email-based matching is reliable because:
- ✅ Supabase Auth requires unique emails
- ✅ Dodo Payments captures customer email
- ✅ Case-insensitive matching handles email variations
- ✅ Exact match fallback ensures accuracy

**No immediate action required** - the system will work correctly with the current implementation.


