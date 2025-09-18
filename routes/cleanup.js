const express = require('express');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { pool } = require('../config/database');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const router = express.Router();

// Manual cleanup endpoint (converted from Next.js API route)
router.post('/', async (req, res) => {
  try {
    const now = new Date().toISOString();
    
    // Find expired files
    const expiredFilesResult = await pool.query(`
      SELECT id, file_path, expires_at, view_count, type
      FROM drops 
      WHERE (expires_at < $1 OR view_count >= 1)
      AND file_path IS NOT NULL
      AND type = 'file'
    `, [now]);

    const expiredFiles = expiredFilesResult.rows;
    let cleanedCount = 0;

    if (expiredFiles.length > 0) {
      // Delete files from Supabase Storage
      const filesToDelete = expiredFiles
        .filter(file => file.file_path)
        .map(file => file.file_path);

      if (filesToDelete.length > 0) {
        try {
          const { data, error } = await supabase.storage
            .from('vanish-drop-files')
            .remove(filesToDelete);

          if (error) {
            console.warn('Supabase storage cleanup error:', error);
          } else {
            cleanedCount = filesToDelete.length;
            console.log(`🗑️ Deleted ${cleanedCount} files from Supabase Storage`);
          }
        } catch (storageError) {
          console.warn('Storage cleanup failed:', storageError);
        }
      }

      // Mark as expired in database
      const fileIds = expiredFiles.map(file => file.id);
      await pool.query(`
        UPDATE drops 
        SET 
          file_path = NULL,
          updated_at = NOW()
        WHERE id = ANY($1)
      `, [fileIds]);

      console.log(`🧹 Cleaned up ${cleanedCount} expired files`);
    }

    res.json({ 
      success: true, 
      cleanedFiles: cleanedCount,
      message: `Cleaned up ${cleanedCount} expired files`
    });
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({ 
      error: 'Cleanup failed',
      code: 'CLEANUP_ERROR'
    });
  }
});

// Get cleanup statistics
router.get('/stats', async (req, res) => {
  try {
    const statsResult = await pool.query(`
      SELECT 
        COUNT(*) as total_drops,
        COUNT(CASE WHEN expires_at < NOW() OR view_count >= 1 THEN 1 END) as expired_drops,
        COUNT(CASE WHEN expires_at >= NOW() AND view_count = 0 THEN 1 END) as active_drops,
        SUM(CASE WHEN file_path IS NOT NULL AND type = 'file' THEN file_size ELSE 0 END) as total_storage_used
      FROM drops
    `);

    const stats = statsResult.rows[0];

    res.json({
      stats: {
        totalDrops: parseInt(stats.total_drops),
        expiredDrops: parseInt(stats.expired_drops),
        activeDrops: parseInt(stats.active_drops),
        totalStorageUsed: parseInt(stats.total_storage_used) || 0
      }
    });
  } catch (error) {
    console.error('Cleanup stats error:', error);
    res.status(500).json({
      error: 'Failed to get cleanup stats',
      code: 'CLEANUP_STATS_ERROR'
    });
  }
});

// Auto-cleanup function that can be called by cron or manually
const performAutoCleanup = async () => {
  try {
    console.log('🕒 Starting automatic cleanup...');
    
    const now = new Date().toISOString();
    
    // Find expired files
    const expiredFilesResult = await pool.query(`
      SELECT id, file_path, expires_at, view_count, type, created_at
      FROM drops 
      WHERE (expires_at < $1 OR view_count >= 1)
      AND file_path IS NOT NULL
      AND type = 'file'
    `, [now]);

    const expiredFiles = expiredFilesResult.rows;
    let cleanedCount = 0;

    // Delete files from Supabase Storage
    const filesToDelete = expiredFiles
      .filter(file => file.file_path)
      .map(file => file.file_path);

    if (filesToDelete.length > 0) {
      try {
        const { data, error } = await supabase.storage
          .from('vanish-drop-files')
          .remove(filesToDelete);

        if (error) {
          console.warn('Auto-cleanup storage error:', error);
        } else {
          cleanedCount = filesToDelete.length;
        }
      } catch (storageError) {
        console.warn('Auto-cleanup storage failed:', storageError);
      }
    }

    // Update database - remove file paths for expired files
    if (expiredFiles.length > 0) {
      const fileIds = expiredFiles.map(file => file.id);
      await pool.query(`
        UPDATE drops 
        SET 
          file_path = NULL,
          updated_at = NOW()
        WHERE id = ANY($1)
      `, [fileIds]);
    }

    // Also clean up very old expired entries (older than 30 days)
    const thirtyDaysAgo = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000)).toISOString();
    const oldEntriesResult = await pool.query(`
      DELETE FROM drops 
      WHERE (expires_at < $1 OR view_count >= 1)
      AND created_at < $2
      RETURNING id
    `, [now, thirtyDaysAgo]);

    const deletedOldEntries = oldEntriesResult.rows.length;

    console.log(`✅ Auto-cleanup completed: ${cleanedCount} files cleaned, ${deletedOldEntries} old entries removed`);
    
    return {
      filesDeleted: cleanedCount,
      entriesDeleted: deletedOldEntries
    };
  } catch (error) {
    console.error('❌ Auto-cleanup failed:', error);
    throw error;
  }
};

// Schedule automatic cleanup every hour
const scheduleAutoCleanup = () => {
  // Run every hour
  cron.schedule('0 * * * *', async () => {
    try {
      await performAutoCleanup();
    } catch (error) {
      console.error('Scheduled cleanup failed:', error);
    }
  });

  console.log('🕒 Automatic cleanup scheduled (every hour)');
};

// Export the cleanup function for use in server startup
module.exports = router;
module.exports.performAutoCleanup = performAutoCleanup;
module.exports.scheduleAutoCleanup = scheduleAutoCleanup;
