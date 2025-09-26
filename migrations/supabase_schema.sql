-- VanishDrop Supabase Database Schema
-- Run this in your Supabase SQL Editor

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create drops table (main table for file/message sharing)
CREATE TABLE IF NOT EXISTS drops (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token VARCHAR(64) UNIQUE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  tier VARCHAR(20) NOT NULL DEFAULT 'free',
  type VARCHAR(20) NOT NULL DEFAULT 'file',
  filename VARCHAR(255),
  original_filename VARCHAR(255),
  file_path TEXT,
  message_content TEXT,
  mimetype VARCHAR(100),
  file_size BIGINT DEFAULT 0,
  password_hash VARCHAR(255),
  otp_code VARCHAR(6),
  otp_expires_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  view_once BOOLEAN DEFAULT true,
  view_count INTEGER DEFAULT 0,
  download_count INTEGER DEFAULT 0,
  max_access_count INTEGER DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_accessed TIMESTAMP WITH TIME ZONE,
  ip_address INET,
  protection_type VARCHAR(20) DEFAULT 'none',
  qr_code TEXT,
  webhook_url TEXT
);

-- Create ip_usage table for free tier tracking
CREATE TABLE IF NOT EXISTS ip_usage (
  ip_address INET PRIMARY KEY,
  total_uploads INTEGER DEFAULT 0,
  first_upload TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_upload TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  is_blocked BOOLEAN DEFAULT FALSE
);

-- Create user_stats table
CREATE TABLE IF NOT EXISTS user_stats (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  total_uploads INTEGER DEFAULT 0,
  total_downloads INTEGER DEFAULT 0,
  storage_used BIGINT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create request_portals table (Business tier)
CREATE TABLE IF NOT EXISTS request_portals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token VARCHAR(64) UNIQUE NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  max_files INTEGER DEFAULT 10,
  max_file_size BIGINT,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  files_received INTEGER DEFAULT 0,
  notification_email VARCHAR(255),
  webhook_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create api_keys table (Business tier)
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100) NOT NULL,
  permissions JSONB DEFAULT '[]',
  last_used TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE
);

-- Create download_logs table
CREATE TABLE IF NOT EXISTS download_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  drop_id UUID NOT NULL REFERENCES drops(id) ON DELETE CASCADE,
  downloaded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  ip_address INET
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_drops_token ON drops(token);
CREATE INDEX IF NOT EXISTS idx_drops_user_id ON drops(user_id);
CREATE INDEX IF NOT EXISTS idx_drops_expires_at ON drops(expires_at);
CREATE INDEX IF NOT EXISTS idx_drops_ip_address ON drops(ip_address);
CREATE INDEX IF NOT EXISTS idx_ip_usage_ip ON ip_usage(ip_address);
CREATE INDEX IF NOT EXISTS idx_download_logs_drop_id ON download_logs(drop_id);

-- Enable Row Level Security (RLS)
ALTER TABLE drops ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_portals ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for drops table
CREATE POLICY "Users can view their own drops" ON drops
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own drops" ON drops
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own drops" ON drops
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own drops" ON drops
  FOR DELETE USING (auth.uid() = user_id);

-- Allow public access to drops by token (for sharing)
CREATE POLICY "Public can access drops by token" ON drops
  FOR SELECT USING (true);

-- Create RLS policies for user_stats table
CREATE POLICY "Users can view their own stats" ON user_stats
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own stats" ON user_stats
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own stats" ON user_stats
  FOR UPDATE USING (auth.uid() = user_id);

-- Create RLS policies for request_portals table
CREATE POLICY "Users can manage their own portals" ON request_portals
  FOR ALL USING (auth.uid() = user_id);

-- Create RLS policies for api_keys table
CREATE POLICY "Users can manage their own api keys" ON api_keys
  FOR ALL USING (auth.uid() = user_id);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger for user_stats updated_at
CREATE TRIGGER update_user_stats_updated_at
  BEFORE UPDATE ON user_stats
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Grant necessary permissions
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
