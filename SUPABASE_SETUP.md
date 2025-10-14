# Supabase Setup Guide for VanishDrop

## Prerequisites
- Supabase account (already created)
- Project URL: `https://mafttcvhinlestxrtjfa.supabase.co`
- Anon Key: Already configured in the app

## Step 1: Create Database Tables

1. Go to your Supabase Dashboard: https://supabase.com/dashboard/project/mafttcvhinlestxrtjfa
2. Navigate to **SQL Editor** in the left sidebar
3. Click **New Query**
4. Copy and paste the entire contents of `supabase-schema.sql` file
5. Click **Run** to execute the SQL

This will create:
- `users` table
- `uploaded_files` table
- `share_links` table
- `access_logs` table
- All necessary indexes
- Row Level Security (RLS) policies
- Automatic triggers for user profile creation

## Step 2: Enable OAuth Providers

### Google OAuth
1. Go to **Authentication** > **Providers** in Supabase Dashboard
2. Find **Google** and click to enable
3. You'll need to create a Google OAuth app:
   - Go to https://console.cloud.google.com/
   - Create a new project or select existing
   - Enable Google+ API
   - Go to **Credentials** > **Create Credentials** > **OAuth 2.0 Client ID**
   - Set **Authorized redirect URIs** to:
     ```
     https://mafttcvhinlestxrtjfa.supabase.co/auth/v1/callback
     ```
   - Copy **Client ID** and **Client Secret**
4. Paste the credentials in Supabase Google provider settings
5. Click **Save**

### GitHub OAuth
1. Go to **Authentication** > **Providers** in Supabase Dashboard
2. Find **GitHub** and click to enable
3. Create a GitHub OAuth app:
   - Go to https://github.com/settings/developers
   - Click **New OAuth App**
   - Set **Authorization callback URL** to:
     ```
     https://mafttcvhinlestxrtjfa.supabase.co/auth/v1/callback
     ```
   - Copy **Client ID** and **Client Secret**
4. Paste the credentials in Supabase GitHub provider settings
5. Click **Save**

## Step 3: Configure Email Templates (Optional)

1. Go to **Authentication** > **Email Templates**
2. Customize the following templates:
   - **Confirm signup**: Welcome email
   - **Magic Link**: Passwordless login
   - **Change Email Address**: Email change confirmation
   - **Reset Password**: Password reset email

## Step 4: Set Up Storage for File Uploads

1. Go to **Storage** in the Supabase Dashboard
2. Click **Create a new bucket**
3. Name it `user-files`
4. Set it to **Private** (files accessible only via signed URLs)
5. Click **Create bucket**

### Storage Policies
Add these policies to the `user-files` bucket:

**Upload Policy:**
```sql
CREATE POLICY "Users can upload own files"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'user-files' AND
  auth.uid()::text = (storage.foldername(name))[1]
);
```

**Download Policy:**
```sql
CREATE POLICY "Anyone can download files via signed URL"
ON storage.objects FOR SELECT
USING (bucket_id = 'user-files');
```

**Delete Policy:**
```sql
CREATE POLICY "Users can delete own files"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'user-files' AND
  auth.uid()::text = (storage.foldername(name))[1]
);
```

## Step 5: Test the Setup

1. Start your development server:
   ```bash
   npm run dev
   ```

2. Navigate to http://localhost:5175/

3. Try to sign up with email/password

4. Try OAuth login with Google or GitHub

5. Check the Supabase Dashboard > **Authentication** > **Users** to see if the user was created

6. Check **Table Editor** > **users** to verify the user profile was automatically created

## Environment Variables (For Production)

When deploying to production, use environment variables:

```env
VITE_SUPABASE_URL=https://mafttcvhinlestxrtjfa.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Update `src/lib/supabase.ts` to use these:

```typescript
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
```

## Automatic Cleanup

To automatically clean up expired files, set up a Supabase Edge Function or use a cron job:

1. Go to **Database** > **Functions**
2. Create a new function or use pg_cron extension
3. Schedule the `cleanup_expired_files()` function to run daily:

```sql
SELECT cron.schedule(
  'cleanup-expired-files',
  '0 0 * * *', -- Run at midnight every day
  $$SELECT cleanup_expired_files()$$
);
```

## Security Best Practices

1. **Never expose your service_role key** - Only use the anon key in client-side code
2. **Enable RLS** on all tables (already done in schema)
3. **Use signed URLs** for file downloads
4. **Set up rate limiting** in Supabase Dashboard > **Settings** > **API**
5. **Enable email verification** in **Authentication** > **Settings**

## Troubleshooting

### Users not being created automatically
- Check if the trigger `on_auth_user_created` exists
- Verify the `handle_new_user()` function is working
- Check Supabase logs in **Logs** section

### OAuth not working
- Verify redirect URLs match exactly
- Check OAuth app credentials
- Ensure OAuth providers are enabled in Supabase

### Files not uploading
- Check storage bucket exists and is named `user-files`
- Verify storage policies are set correctly
- Check file size limits in Supabase Dashboard

## Next Steps

1. Implement file upload to Supabase Storage
2. Generate signed URLs for file downloads
3. Set up automatic file expiration
4. Add payment integration for Pro subscriptions
5. Implement email notifications

## Support

For issues with Supabase:
- Supabase Docs: https://supabase.com/docs
- Supabase Discord: https://discord.supabase.com

For VanishDrop specific issues:
- Contact: dropvanish@gmail.com
