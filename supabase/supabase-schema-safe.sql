-- VanishDrop Database Schema for Supabase (Safe Version)
-- This version checks for existing objects before creating them

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT UNIQUE NOT NULL,
  subscription_tier TEXT NOT NULL DEFAULT 'free' CHECK (subscription_tier IN ('free', 'pro')),
  trial_used BOOLEAN DEFAULT FALSE,
  trial_end_date TIMESTAMPTZ,
  daily_upload_used BIGINT DEFAULT 0,
  daily_upload_reset_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Uploaded files table
CREATE TABLE IF NOT EXISTS uploaded_files (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  file_type TEXT NOT NULL,
  file_url TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Share links table
CREATE TABLE IF NOT EXISTS share_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id UUID NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
CREATE TABLE IF NOT EXISTS access_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  share_link_id UUID NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  accessed_at TIMESTAMPTZ DEFAULT NOW(),
  ip_address TEXT NOT NULL,
  success BOOLEAN NOT NULL
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_user_id ON uploaded_files(user_id);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_expires_at ON uploaded_files(expires_at);
CREATE INDEX IF NOT EXISTS idx_share_links_share_token ON share_links(share_token);
CREATE INDEX IF NOT EXISTS idx_share_links_file_id ON share_links(file_id);
CREATE INDEX IF NOT EXISTS idx_share_links_user_id ON share_links(user_id);
CREATE INDEX IF NOT EXISTS idx_share_links_expires_at ON share_links(expires_at);
CREATE INDEX IF NOT EXISTS idx_access_logs_share_link_id ON access_logs(share_link_id);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if exists, then create
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Function to clean up expired files (run this periodically)
CREATE OR REPLACE FUNCTION cleanup_expired_files()
RETURNS void AS $$
BEGIN
  DELETE FROM uploaded_files WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Enable RLS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE uploaded_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE share_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_logs ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist, then recreate them
-- Users policies
DROP POLICY IF EXISTS "Users can view own data" ON users;
CREATE POLICY "Users can view own data" ON users
  FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users can update own data" ON users;
CREATE POLICY "Users can update own data" ON users
  FOR UPDATE USING (auth.uid() = id);

-- Uploaded files policies
DROP POLICY IF EXISTS "Users can view own files" ON uploaded_files;
CREATE POLICY "Users can view own files" ON uploaded_files
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own files" ON uploaded_files;
CREATE POLICY "Users can insert own files" ON uploaded_files
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own files" ON uploaded_files;
CREATE POLICY "Users can delete own files" ON uploaded_files
  FOR DELETE USING (auth.uid() = user_id);

-- Share links policies
DROP POLICY IF EXISTS "Users can view own share links" ON share_links;
CREATE POLICY "Users can view own share links" ON share_links
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create share links for own files" ON share_links;
CREATE POLICY "Users can create share links for own files" ON share_links
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Anyone can view share links by token" ON share_links;
CREATE POLICY "Anyone can view share links by token" ON share_links
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can update own share links" ON share_links;
CREATE POLICY "Users can update own share links" ON share_links
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own share links" ON share_links;
CREATE POLICY "Users can delete own share links" ON share_links
  FOR DELETE USING (auth.uid() = user_id);

-- Access logs policies
DROP POLICY IF EXISTS "Users can view access logs for own share links" ON access_logs;
CREATE POLICY "Users can view access logs for own share links" ON access_logs
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM share_links
      WHERE share_links.id = access_logs.share_link_id
      AND share_links.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Anyone can insert access logs" ON access_logs;
CREATE POLICY "Anyone can insert access logs" ON access_logs
  FOR INSERT WITH CHECK (true);

-- Function to automatically create user profile after signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id, email, subscription_tier, daily_upload_reset_at)
  VALUES (
    NEW.id,
    NEW.email,
    'free',
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop trigger if exists, then create
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
