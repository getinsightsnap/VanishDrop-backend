const { createClient } = require('@supabase/supabase-js');

// Supabase client - Primary database
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY, // Use service role key for backend operations
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// Initialize database tables - Supabase version
async function initializeDatabase() {
  try {
    console.log('✅ Supabase database connection initialized');
    console.log('📝 Note: Run the SQL migrations in your Supabase dashboard to create tables');
    console.log('📁 Migration files available in: backend/migrations/');
  } catch (error) {
    console.error('❌ Supabase initialization failed:', error);
    throw error;
  }
}

module.exports = {
  supabase,
  initializeDatabase
};
