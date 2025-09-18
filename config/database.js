const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Supabase client - Updated to use SUPABASE_KEY
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,  // Changed from SUPABASE_SERVICE_ROLE_KEY
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// Initialize database tables
async function initializeDatabase() {
  try {
    // Create drops table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS drops (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token VARCHAR(64) UNIQUE NOT NULL,
        user_id UUID,
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
        otp_expires_at TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        view_once BOOLEAN DEFAULT true,
        view_count INTEGER DEFAULT 0,
        download_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        last_accessed TIMESTAMP,
        ip_address INET,
        protection_type VARCHAR(20) DEFAULT 'none',
        qr_code TEXT,
        webhook_url TEXT
      )
    `);

    // Create ip_usage table for free tier tracking
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ip_usage (
        ip_address INET PRIMARY KEY,
        total_uploads INTEGER DEFAULT 0,
        first_upload TIMESTAMP DEFAULT NOW(),
        last_upload TIMESTAMP DEFAULT NOW(),
        is_blocked BOOLEAN DEFAULT FALSE
      )
    `);

    // Create user_stats table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_stats (
        user_id UUID PRIMARY KEY,
        total_uploads INTEGER DEFAULT 0,
        total_downloads INTEGER DEFAULT 0,
        storage_used BIGINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create request_portals table (Business tier)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS request_portals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token VARCHAR(64) UNIQUE NOT NULL,
        user_id UUID NOT NULL,
        title VARCHAR(255) NOT NULL,
        max_files INTEGER DEFAULT 10,
        max_file_size BIGINT,
        expires_at TIMESTAMP NOT NULL,
        files_received INTEGER DEFAULT 0,
        notification_email VARCHAR(255),
        webhook_url TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // Create api_keys table (Business tier)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        key_hash VARCHAR(255) NOT NULL,
        name VARCHAR(100) NOT NULL,
        permissions JSONB DEFAULT '[]',
        last_used TIMESTAMP,
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        is_active BOOLEAN DEFAULT TRUE
      )
    `);

    // Create indexes for performance
    await pool.query('CREATE INDEX IF NOT EXISTS idx_drops_token ON drops(token)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_drops_user_id ON drops(user_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_drops_expires_at ON drops(expires_at)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_drops_ip_address ON drops(ip_address)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ip_usage_ip ON ip_usage(ip_address)');

    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
}

module.exports = {
  pool,
  supabase,
  initializeDatabase
};
