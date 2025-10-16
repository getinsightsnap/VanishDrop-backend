import cron from 'node-cron';
import { supabaseAdmin } from '../../config/supabase.js';
import logger, { logCleanup } from '../utils/logger.js';

// Cleanup expired files
export const cleanupExpiredFiles = async () => {
  try {
    console.log('🧹 Starting cleanup of expired files...');

    // Get all expired files
    const { data: expiredFiles, error: fetchError } = await supabaseAdmin
      .from('uploaded_files')
      .select('*')
      .lt('expires_at', new Date().toISOString());

    if (fetchError) {
      console.error('Error fetching expired files:', fetchError);
      return;
    }

    if (!expiredFiles || expiredFiles.length === 0) {
      console.log('✅ No expired files to clean up');
      return;
    }

    console.log(`📦 Found ${expiredFiles.length} expired files to delete`);

    let deletedCount = 0;
    let errorCount = 0;

    // Delete each file from storage and database
    for (const file of expiredFiles) {
      try {
        // Extract file path from URL
        const url = file.file_url;
        const parts = url.split('/');
        const filePath = `${file.user_id}/${parts[parts.length - 1]}`;

        // Delete from storage
        const { error: storageError } = await supabaseAdmin.storage
          .from('user-files')
          .remove([filePath]);

        if (storageError) {
          console.error(`Failed to delete file from storage: ${filePath}`, storageError);
          errorCount++;
          continue;
        }

        // Delete from database (cascade will delete related share links and access logs)
        const { error: dbError } = await supabaseAdmin
          .from('uploaded_files')
          .delete()
          .eq('id', file.id);

        if (dbError) {
          console.error(`Failed to delete file from database: ${file.id}`, dbError);
          errorCount++;
        } else {
          deletedCount++;
        }
      } catch (error) {
        console.error(`Error deleting file ${file.id}:`, error);
        errorCount++;
      }
    }

    logger.info(`✅ Cleanup completed: ${deletedCount} files deleted, ${errorCount} errors`);
    logCleanup('expired_files', deletedCount);
  } catch (error) {
    console.error('Error in cleanup job:', error);
  }
};

// Move expired share links to history table instead of deleting them
export const cleanupExpiredShareLinks = async () => {
  try {
    console.log('🧹 Moving expired share links to history...');

    const { data: expiredLinks, error: fetchError } = await supabaseAdmin
      .from('share_links')
      .select(`
        id,
        user_id,
        share_token,
        expires_at,
        max_opens,
        current_opens,
        password_hash,
        require_otp,
        qr_code_enabled,
        has_watermark,
        created_at,
        uploaded_files (
          filename,
          file_size,
          file_type
        )
      `)
      .lt('expires_at', new Date().toISOString());

    if (fetchError) {
      console.error('Error fetching expired links:', fetchError);
      return;
    }

    if (!expiredLinks || expiredLinks.length === 0) {
      console.log('✅ No expired share links found');
      return;
    }

    console.log(`📦 Found ${expiredLinks.length} expired share links to archive`);

    // Move each expired link to history
    let archivedCount = 0;
    let errorCount = 0;

    for (const link of expiredLinks) {
      try {
        // Insert into history table
        const { error: insertError } = await supabaseAdmin
          .from('share_link_history')
          .insert({
            original_share_link_id: link.id,
            user_id: link.user_id,
            file_name: link.uploaded_files?.filename || 'Unknown file',
            file_size: link.uploaded_files?.file_size || 0,
            file_type: link.uploaded_files?.file_type || 'unknown',
            share_token: link.share_token,
            expires_at: link.expires_at,
            max_opens: link.max_opens,
            final_opens: link.current_opens || 0,
            had_password: !!link.password_hash,
            had_otp: link.require_otp || false,
            had_qr_code: link.qr_code_enabled || false,
            had_watermark: link.has_watermark || false,
            created_at: link.created_at,
            archived_at: new Date().toISOString(),
            status: 'expired'
          });

        if (insertError) {
          console.error(`Error archiving link ${link.id}:`, insertError);
          errorCount++;
          continue;
        }

        // Delete the original share link
        const { error: deleteError } = await supabaseAdmin
          .from('share_links')
          .delete()
          .eq('id', link.id);

        if (deleteError) {
          console.error(`Error deleting original link ${link.id}:`, deleteError);
          errorCount++;
        } else {
          archivedCount++;
        }
      } catch (error) {
        console.error(`Error processing link ${link.id}:`, error);
        errorCount++;
      }
    }

    console.log(`✅ Archive completed: ${archivedCount} links archived, ${errorCount} errors`);
    logger.info(`✅ Share links cleanup completed: ${archivedCount} links moved to history, ${errorCount} errors`);
  } catch (error) {
    console.error('Error in share links cleanup:', error);
    logger.error('Share links cleanup failed:', error);
  }
};

// Reset daily upload limits (runs at midnight)
export const resetDailyLimits = async () => {
  try {
    console.log('🔄 Starting reset of daily upload limits...');

    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Reset for users whose reset time was more than 24 hours ago
    const { data, error } = await supabaseAdmin
      .from('users')
      .update({
        daily_upload_used: 0,
        daily_upload_reset_at: now.toISOString()
      })
      .lt('daily_upload_reset_at', twentyFourHoursAgo.toISOString())
      .select();

    if (error) {
      console.error('Error resetting daily limits:', error);
    } else {
      console.log(`✅ Reset daily limits for ${data?.length || 0} users`);
    }
  } catch (error) {
    console.error('Error in daily limit reset job:', error);
  }
};

// Cleanup old access logs (older than 30 days)
export const cleanupOldLogs = async () => {
  try {
    console.log('🧹 Starting cleanup of old access logs...');

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data, error } = await supabaseAdmin
      .from('access_logs')
      .delete()
      .lt('accessed_at', thirtyDaysAgo.toISOString())
      .select();

    if (error) {
      console.error('Error deleting old logs:', error);
    } else {
      console.log(`✅ Deleted ${data?.length || 0} old access logs`);
    }
  } catch (error) {
    console.error('Error in log cleanup job:', error);
  }
};

// Check and downgrade expired trials
export const checkExpiredTrials = async () => {
  try {
    console.log('🔍 Checking for expired trials...');

    const now = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('users')
      .update({ subscription_tier: 'free' })
      .eq('subscription_tier', 'pro')
      .not('trial_end_date', 'is', null)
      .lt('trial_end_date', now)
      .select();

    if (error) {
      console.error('Error checking expired trials:', error);
    } else if (data && data.length > 0) {
      console.log(`✅ Downgraded ${data.length} expired trial users to free tier`);
    } else {
      console.log('✅ No expired trials to process');
    }
  } catch (error) {
    console.error('Error in trial expiration check:', error);
  }
};

// Initialize all cron jobs
export const initializeCronJobs = () => {
  console.log('⏰ Initializing scheduled jobs...');

  // Run cleanup every hour
  cron.schedule('0 * * * *', async () => {
    console.log('⏰ Running hourly cleanup jobs...');
    await cleanupExpiredFiles();
    await cleanupExpiredShareLinks();
  });

  // Reset daily limits at midnight every day
  cron.schedule('0 0 * * *', async () => {
    console.log('⏰ Running daily midnight jobs...');
    await resetDailyLimits();
    await checkExpiredTrials();
  });

  // Cleanup old logs once a week (Sunday at 2 AM)
  cron.schedule('0 2 * * 0', async () => {
    console.log('⏰ Running weekly cleanup jobs...');
    await cleanupOldLogs();
  });

  console.log('✅ Scheduled jobs initialized successfully');
};

export default {
  cleanupExpiredFiles,
  cleanupExpiredShareLinks,
  resetDailyLimits,
  cleanupOldLogs,
  checkExpiredTrials,
  initializeCronJobs,
};

