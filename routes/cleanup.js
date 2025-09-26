const express = require('express');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { supabase } = require('../config/database');

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
    const { data: expiredFiles, error: expiredError } = await supabase
      .from('drops')
      .select('id, file_path, expires_at, view_count, type, max_access_count')
      .or(`expires_at.lt.${now},view_count.gte.max_access_count`)
      .not('file_path', 'is', null)
      .eq('type', 'file');

    if (expiredError) {
      throw new Error(`Failed to fetch expired files: ${expiredError.message}`);
    }
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
      const { error: updateError } = await supabase
        .from('drops')
        .update({
          file_path: null,
          updated_at: new Date().toISOString()
        })
        .in('id', fileIds);

      if (updateError) {
        console.warn('Failed to update expired files:', updateError);
      }

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
    const now = new Date().toISOString();
    
    // Get total drops
    const { count: totalDrops } = await supabase
      .from('drops')
      .select('*', { count: 'exact', head: true });

    // Get expired drops
    const { count: expiredDrops } = await supabase
      .from('drops')
      .select('*', { count: 'exact', head: true })
      .or(`expires_at.lt.${now},view_count.gte.max_access_count`);

    // Get active drops
    const { count: activeDrops } = await supabase
      .from('drops')
      .select('*', { count: 'exact', head: true })
      .gte('expires_at', now)
      .eq('view_count', 0);

    // Get storage used
    const { data: storageData } = await supabase
      .from('drops')
      .select('file_size')
      .not('file_path', 'is', null)
      .eq('type', 'file');

    const totalStorageUsed = storageData?.reduce((sum, drop) => sum + (drop.file_size || 0), 0) || 0;

    const stats = {
      total_drops: totalDrops || 0,
      expired_drops: expiredDrops || 0,
      active_drops: activeDrops || 0,
      total_storage_used: totalStorageUsed
    };

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
