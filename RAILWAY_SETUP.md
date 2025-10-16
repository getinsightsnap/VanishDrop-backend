# Railway Backend Setup for VanishDrop

## Prerequisites
- Railway account (https://railway.app)
- Dodo Payments account with API key
- Supabase Service Key (for admin operations)

## Environment Variables

Add these to your Railway environment:

```env
SUPABASE_URL=https://mafttcvhinlestxrtjfa.supabase.co
SUPABASE_SERVICE_KEY=your_supabase_service_key_here
DODO_PAYMENTS_API_KEY=BBaQwaRKbrty9MNs.LSJE_s4nyd_RkCRibSqEsOWnaeVc2-7iBIXaKLZ2uLa8PAi_
NODE_ENV=production
```

## Deploy to Railway

1. **Connect Repository**
   ```bash
   # Install Railway CLI
   npm install -g @railway/cli
   
   # Login to Railway
   railway login
   
   # Link to project
   railway link
   ```

2. **Deploy Backend**
   ```bash
   # Deploy from backend directory
   cd backend
   railway up
   ```

3. **Set Environment Variables**
   - Go to Railway dashboard
   - Select your project
   - Go to **Variables** tab
   - Add all environment variables listed above

## Webhook Setup

Once Railway is deployed, you need to configure Dodo Payments webhooks:

1. **Get Railway URL**
   - Railway will provide you with a URL like: `https://your-app.railway.app`

2. **Configure Webhook in Dodo Payments**
   - Go to Dodo Payments Dashboard
   - Navigate to **Developer** → **Webhooks**
   - Click **Add Webhook Endpoint**
   - Set URL to: `https://your-app.railway.app/api/webhook/dodo`
   - Select events to listen for:
     - `payment.succeeded`
     - `payment.failed`
     - `payment.cancelled`
     - `subscription.active`
     - `subscription.activated`
     - `subscription.renewed`
     - `subscription.cancelled`
     - `subscription.expired`
     - `subscription.paused`
     - `subscription.on_hold`
     - `subscription.suspended`
     - `subscription.trial_started`
     - `subscription.trial_ended`
     - `invoice.payment_succeeded`
     - `invoice.payment_failed`
   - Save the webhook

3. **Test Webhook**
   - Use Dodo Payments test mode
   - Create a test payment
   - Check Railway logs to verify webhook is received

## API Endpoints

The backend will expose these endpoints:

- `POST /api/webhook/dodo` - Webhook handler for payment events
- More endpoints can be added as needed

## Monitoring

Monitor your Railway deployment:

```bash
# View logs
railway logs

# Check status
railway status
```

## Security

- Never commit API keys to git
- Use Railway environment variables for all secrets
- Enable webhook signature verification when available
- Use HTTPS only

## Troubleshooting

### Webhook not receiving events
- Check Railway logs for errors
- Verify webhook URL is correct in Dodo Payments
- Ensure Railway service is running

### Subscription not updating
- Check Supabase service key permissions
- Verify user_id is in payment metadata
- Check Railway logs for database errors

## Next Steps

Once Railway is set up:
1. The webhook will automatically update user subscriptions
2. Failed payments will be handled gracefully
3. Subscription status will stay in sync with Dodo Payments

