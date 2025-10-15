-- ============================================================================
-- VanishDrop Complete Database Setup - MASTER SCRIPT
-- ============================================================================
-- Run this ONCE in Supabase SQL Editor
-- This script combines all migrations and sets up everything correctly
-- ============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- STEP 1: Create Tables with Correct Structure
-- ============================================================================

-- Users table (with lifetime_upload_used from the start)
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  subscription_tier TEXT NOT NULL DEFAULT 'free' CHECK (subscription_tier IN ('free', 'pro')),
  trial_used BOOLEAN DEFAULT FALSE,
  trial_end_date TIMESTAMPTZ,
  daily_upload_used BIGINT DEFAULT 0,
  daily_upload_reset_at TIMESTAMPTZ DEFAULT NOW(),
  lifetime_upload_used BIGINT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add lifetime_upload_used if it doesn't exist (for existing tables)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'users' 
    AND column_name = 'lifetime_upload_used'
  ) THEN
    ALTER TABLE public.users ADD COLUMN lifetime_upload_used BIGINT DEFAULT 0;
    RAISE NOTICE '✅ Added lifetime_upload_used column';
  END IF;
END $$;

-- Uploaded files table (user_id will be made nullable later)
CREATE TABLE IF NOT EXISTS public.uploaded_files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  file_type TEXT NOT NULL,
  file_url TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Share links table (user_id will be made nullable later)
CREATE TABLE IF NOT EXISTS public.share_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID NOT NULL REFERENCES public.uploaded_files(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
  share_token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  max_opens INTEGER,
  current_opens INTEGER DEFAULT 0,
  password_hash TEXT,
  require_otp BOOLEAN DEFAULT FALSE,
  qr_code_enabled BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Access logs table
CREATE TABLE IF NOT EXISTS public.access_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  share_link_id UUID NOT NULL REFERENCES public.share_links(id) ON DELETE CASCADE,
  accessed_at TIMESTAMPTZ DEFAULT NOW(),
  ip_address TEXT NOT NULL,
  success BOOLEAN NOT NULL
);

-- ============================================================================
-- STEP 2: Make user_id Nullable for Anonymous Uploads
-- ============================================================================

-- Make user_id nullable in uploaded_files
ALTER TABLE public.uploaded_files ALTER COLUMN user_id DROP NOT NULL;

-- Make user_id nullable in share_links
ALTER TABLE public.share_links ALTER COLUMN user_id DROP NOT NULL;

-- Add comments
COMMENT ON COLUMN public.users.lifetime_upload_used IS 'Total lifetime upload usage in bytes for free users (1GB limit)';
COMMENT ON COLUMN public.uploaded_files.user_id IS 'User ID for authenticated uploads, NULL for anonymous uploads';
COMMENT ON COLUMN public.share_links.user_id IS 'User ID for authenticated share links, NULL for anonymous share links';

-- ============================================================================
-- STEP 3: Create Indexes for Performance
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_user_id ON public.uploaded_files(user_id);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_expires_at ON public.uploaded_files(expires_at);
CREATE INDEX IF NOT EXISTS idx_share_links_share_token ON public.share_links(share_token);
CREATE INDEX IF NOT EXISTS idx_share_links_file_id ON public.share_links(file_id);
CREATE INDEX IF NOT EXISTS idx_share_links_user_id ON public.share_links(user_id);
CREATE INDEX IF NOT EXISTS idx_share_links_expires_at ON public.share_links(expires_at);
CREATE INDEX IF NOT EXISTS idx_access_logs_share_link_id ON public.access_logs(share_link_id);

-- ============================================================================
-- STEP 4: Create Functions
-- ============================================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to clean up expired files
CREATE OR REPLACE FUNCTION public.cleanup_expired_files()
RETURNS void AS $$
BEGIN
  DELETE FROM public.uploaded_files WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Function to automatically create user profile after signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (
    id,
    email,
    subscription_tier,
    trial_used,
    daily_upload_used,
    daily_upload_reset_at,
    lifetime_upload_used,
    created_at,
    updated_at
  )
  VALUES (
    NEW.id,
    NEW.email,
    'free',
    FALSE,
    0,
    NOW(),
    0,
    NOW(),
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;
  
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Error creating user profile: %', SQLERRM;
    RETURN NEW;
END;
$$;

-- ============================================================================
-- STEP 5: Create Triggers
-- ============================================================================

-- Trigger for updating updated_at
DROP TRIGGER IF EXISTS update_users_updated_at ON public.users;
CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Trigger for auto-creating user profiles
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ============================================================================
-- STEP 6: Enable Row Level Security
-- ============================================================================

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uploaded_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.share_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_logs ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- STEP 7: Create RLS Policies (Supporting Anonymous Uploads)
-- ============================================================================

-- Users policies
DROP POLICY IF EXISTS "Users can view own data" ON public.users;
CREATE POLICY "Users can view own data" ON public.users
  FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update own data" ON public.users;
CREATE POLICY "Users can update own data" ON public.users
  FOR UPDATE USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users can insert own data" ON public.users;
CREATE POLICY "Users can insert own data" ON public.users
  FOR INSERT WITH CHECK (auth.uid() = id);

-- Uploaded files policies (supports anonymous uploads)
DROP POLICY IF EXISTS "Users can view own files" ON public.uploaded_files;
DROP POLICY IF EXISTS "Allow file viewing" ON public.uploaded_files;
CREATE POLICY "Allow file viewing" ON public.uploaded_files
  FOR SELECT USING (
    (auth.uid() IS NOT NULL AND user_id = auth.uid()) OR
    user_id IS NULL
  );

DROP POLICY IF EXISTS "Users can insert own files" ON public.uploaded_files;
DROP POLICY IF EXISTS "Allow file uploads" ON public.uploaded_files;
CREATE POLICY "Allow file uploads" ON public.uploaded_files
  FOR INSERT WITH CHECK (
    (auth.uid() IS NOT NULL AND user_id = auth.uid()) OR
    (auth.uid() IS NULL AND user_id IS NULL)
  );

DROP POLICY IF EXISTS "Users can delete own files" ON public.uploaded_files;
CREATE POLICY "Users can delete own files" ON public.uploaded_files
  FOR DELETE USING (auth.uid() = user_id);

-- Share links policies (supports anonymous links)
DROP POLICY IF EXISTS "Users can view own share links" ON public.share_links;
DROP POLICY IF EXISTS "Allow share link viewing" ON public.share_links;
CREATE POLICY "Allow share link viewing" ON public.share_links
  FOR SELECT USING (
    (auth.uid() IS NOT NULL AND user_id = auth.uid()) OR
    user_id IS NULL
  );

DROP POLICY IF EXISTS "Users can create share links for own files" ON public.share_links;
DROP POLICY IF EXISTS "Allow share link creation" ON public.share_links;
CREATE POLICY "Allow share link creation" ON public.share_links
  FOR INSERT WITH CHECK (
    (auth.uid() IS NOT NULL AND user_id = auth.uid()) OR
    (auth.uid() IS NULL AND user_id IS NULL)
  );

DROP POLICY IF EXISTS "Anyone can view share links by token" ON public.share_links;
CREATE POLICY "Anyone can view share links by token" ON public.share_links
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can update own share links" ON public.share_links;
CREATE POLICY "Users can update own share links" ON public.share_links
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own share links" ON public.share_links;
CREATE POLICY "Users can delete own share links" ON public.share_links
  FOR DELETE USING (auth.uid() = user_id);

-- Access logs policies
DROP POLICY IF EXISTS "Users can view access logs for own share links" ON public.access_logs;
CREATE POLICY "Users can view access logs for own share links" ON public.access_logs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.share_links
      WHERE share_links.id = access_logs.share_link_id
      AND share_links.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Anyone can insert access logs" ON public.access_logs;
CREATE POLICY "Anyone can insert access logs" ON public.access_logs
  FOR INSERT WITH CHECK (true);

-- ============================================================================
-- STEP 8: Grant Permissions
-- ============================================================================

GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON public.users TO postgres, service_role;
GRANT ALL ON public.uploaded_files TO postgres, service_role;
GRANT ALL ON public.share_links TO postgres, service_role;
GRANT ALL ON public.access_logs TO postgres, service_role;

GRANT SELECT, INSERT, UPDATE ON public.users TO authenticated;
GRANT SELECT ON public.users TO anon;
GRANT SELECT, INSERT, DELETE ON public.uploaded_files TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.share_links TO authenticated, anon;
GRANT SELECT, INSERT ON public.access_logs TO authenticated, anon;

-- ============================================================================
-- STEP 9: Initialize Existing Data
-- ============================================================================

-- Initialize lifetime_upload_used for existing users
UPDATE public.users 
SET lifetime_upload_used = 0 
WHERE lifetime_upload_used IS NULL;

-- ============================================================================
-- SUCCESS MESSAGE
-- ============================================================================

DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '============================================================================';
  RAISE NOTICE '✅ VanishDrop Database Setup Complete!';
  RAISE NOTICE '============================================================================';
  RAISE NOTICE '';
  RAISE NOTICE '✅ All tables created with correct structure';
  RAISE NOTICE '✅ lifetime_upload_used column added (1GB limit for free users)';
  RAISE NOTICE '✅ Anonymous uploads enabled (user_id can be NULL)';
  RAISE NOTICE '✅ RLS policies configured for authenticated and anonymous users';
  RAISE NOTICE '✅ Auto-signup trigger created';
  RAISE NOTICE '✅ Indexes created for performance';
  RAISE NOTICE '';
  RAISE NOTICE '🚀 Your database is ready! Deploy your backend and test uploads.';
  RAISE NOTICE '';
  RAISE NOTICE '============================================================================';
END $$;

