# VanishDrop Troubleshooting Guide

## Error: "Database error saving new user"

This error occurs when Supabase Auth successfully creates a user, but the trigger to create their profile in the `users` table fails.

### Quick Fix:

1. **Go to Supabase Dashboard**
   - Navigate to: https://supabase.com/dashboard/project/mafttcvhinlestxrtjfa
   - Click on **SQL Editor** in the left sidebar

2. **Run the Fix Script**
   - Copy the entire contents of `backend/supabase/fix-user-creation.sql`
   - Paste it into a new query
   - Click **Run**

3. **Verify the Fix**
   - The script will show a success message
   - Check that the trigger exists in the output

4. **Test Signup**
   - Go to your app
   - Try creating a new account
   - Should work now!

### Alternative: Manual User Creation

If the trigger still doesn't work, you can manually create user profiles:

```sql
-- After a user signs up via Auth, manually create their profile
INSERT INTO public.users (id, email, subscription_tier, daily_upload_reset_at)
VALUES (
  'user-uuid-from-auth-users-table',
  'user@example.com',
  'free',
  NOW()
);
```

### Common Causes:

1. **RLS Policies Too Restrictive**
   - The trigger runs as the postgres user
   - Needs proper permissions
   - Fix: Use `SECURITY DEFINER` in function

2. **Missing Permissions**
   - The function needs access to the users table
   - Fix: Grant proper permissions (included in fix script)

3. **Conflicting Triggers**
   - Old triggers might interfere
   - Fix: Drop old triggers first (included in fix script)

### Verify Database Setup:

Run this query to check your setup:

```sql
-- Check if users table exists
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_name = 'users';

-- Check if trigger exists
SELECT trigger_name, event_object_table 
FROM information_schema.triggers 
WHERE trigger_name = 'on_auth_user_created';

-- Check if function exists
SELECT routine_name 
FROM information_schema.routines 
WHERE routine_schema = 'public' 
AND routine_name = 'handle_new_user';

-- Check RLS policies
SELECT schemaname, tablename, policyname 
FROM pg_policies 
WHERE tablename = 'users';
```

### Check Existing Users:

```sql
-- View all users in auth.users
SELECT id, email, created_at 
FROM auth.users 
ORDER BY created_at DESC 
LIMIT 10;

-- View all profiles in public.users
SELECT id, email, subscription_tier, created_at 
FROM public.users 
ORDER BY created_at DESC 
LIMIT 10;

-- Find users without profiles
SELECT au.id, au.email, au.created_at
FROM auth.users au
LEFT JOIN public.users pu ON au.id = pu.id
WHERE pu.id IS NULL;
```

### Manual Profile Creation for Existing Users:

If you have users in `auth.users` without profiles in `public.users`:

```sql
-- Create profiles for all existing auth users
INSERT INTO public.users (id, email, subscription_tier, daily_upload_reset_at)
SELECT 
  au.id,
  au.email,
  'free',
  NOW()
FROM auth.users au
LEFT JOIN public.users pu ON au.id = pu.id
WHERE pu.id IS NULL
ON CONFLICT (id) DO NOTHING;
```

### Enable Detailed Logging:

To see what's happening with the trigger:

```sql
-- Enable function logging
ALTER FUNCTION public.handle_new_user() SET log_min_messages = 'debug';

-- Check logs after signup attempt
-- Go to: Dashboard > Logs > Postgres Logs
```

### Test the Trigger Manually:

```sql
-- Create a test user (will be cleaned up)
DO $$
DECLARE
  test_user_id UUID := gen_random_uuid();
BEGIN
  -- This simulates what happens during signup
  INSERT INTO auth.users (id, email)
  VALUES (test_user_id, 'test@example.com');
  
  -- Check if profile was created
  IF EXISTS (SELECT 1 FROM public.users WHERE id = test_user_id) THEN
    RAISE NOTICE 'SUCCESS: User profile created automatically!';
  ELSE
    RAISE NOTICE 'FAILED: User profile was not created';
  END IF;
  
  -- Cleanup
  DELETE FROM auth.users WHERE id = test_user_id;
END $$;
```

### Still Having Issues?

1. **Check Supabase Logs:**
   - Dashboard > Logs > Postgres Logs
   - Look for errors related to `handle_new_user`

2. **Verify Permissions:**
   ```sql
   -- Check table permissions
   SELECT grantee, privilege_type 
   FROM information_schema.role_table_grants 
   WHERE table_name = 'users';
   ```

3. **Disable RLS Temporarily (for testing only):**
   ```sql
   ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;
   -- Try signup
   -- Then re-enable:
   ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
   ```

4. **Contact Support:**
   - Supabase Discord: https://discord.supabase.com
   - VanishDrop: dropvanish@gmail.com

### Prevention:

After fixing, verify with every deployment:
- ✅ Trigger exists and is enabled
- ✅ Function has SECURITY DEFINER
- ✅ Permissions are granted
- ✅ RLS policies allow inserts
- ✅ Test signup works

## Other Common Errors

### "Invalid JWT token"
- Token expired
- Wrong Supabase URL/Key
- Check environment variables

### "Row Level Security policy violation"
- RLS policies too restrictive
- Check policy conditions
- Verify user permissions

### "Storage bucket not found"
- Create `user-files` bucket
- Set bucket to private
- Add storage policies

### "CORS error"
- Add your domain to Supabase allowed origins
- Dashboard > Settings > API > CORS

## Need More Help?

Check the main documentation:
- `backend/README.md` - Backend setup
- `backend/SUPABASE_SETUP.md` - Database setup
- `DEPLOYMENT.md` - Deployment guide
