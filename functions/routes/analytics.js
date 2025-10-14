import express from 'express';
import { supabaseAdmin } from '../../config/supabase.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// Get user's detailed analytics
router.get('/user', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { days = 30 } = req.query;

    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - parseInt(days));

    // File upload trends
    const { data: uploadTrends } = await supabaseAdmin
      .from('uploaded_files')
      .select('uploaded_at, file_size, file_type')
      .eq('user_id', userId)
      .gte('uploaded_at', daysAgo.toISOString())
      .order('uploaded_at', { ascending: true });

    // Share link performance
    const { data: shareLinkStats } = await supabaseAdmin
      .from('share_links')
      .select(`
        id,
        created_at,
        current_opens,
        max_opens,
        uploaded_files (filename, file_type)
      `)
      .eq('user_id', userId)
      .gte('created_at', daysAgo.toISOString());

    // Access logs for user's links
    const userLinkIds = shareLinkStats?.map(link => link.id) || [];
    let accessLogs = [];
    
    if (userLinkIds.length > 0) {
      const { data: logs } = await supabaseAdmin
        .from('access_logs')
        .select('*')
        .in('share_link_id', userLinkIds)
        .gte('accessed_at', daysAgo.toISOString());
      accessLogs = logs || [];
    }

    // Calculate analytics
    const totalUploads = uploadTrends?.length || 0;
    const totalStorage = uploadTrends?.reduce((sum, file) => sum + file.file_size, 0) || 0;
    const totalShares = shareLinkStats?.length || 0;
    const totalAccesses = accessLogs.length;
    const successfulAccesses = accessLogs.filter(log => log.success).length;

    // File type distribution
    const fileTypes = {};
    uploadTrends?.forEach(file => {
      const type = file.file_type.split('/')[0] || 'other';
      fileTypes[type] = (fileTypes[type] || 0) + 1;
    });

    // Daily upload trends
    const dailyTrends = {};
    uploadTrends?.forEach(file => {
      const date = new Date(file.uploaded_at).toISOString().split('T')[0];
      if (!dailyTrends[date]) {
        dailyTrends[date] = { count: 0, size: 0 };
      }
      dailyTrends[date].count++;
      dailyTrends[date].size += file.file_size;
    });

    // Most accessed files
    const fileStat = {};
    accessLogs.forEach(log => {
      const linkId = log.share_link_id;
      fileStat[linkId] = (fileStat[linkId] || 0) + 1;
    });

    const topFiles = shareLinkStats
      ?.map(link => ({
        filename: link.uploaded_files?.filename || 'Unknown',
        fileType: link.uploaded_files?.file_type || 'Unknown',
        opens: link.current_opens,
        maxOpens: link.max_opens,
        totalAccesses: fileStat[link.id] || 0
      }))
      .sort((a, b) => b.totalAccesses - a.totalAccesses)
      .slice(0, 10);

    res.json({
      period: {
        days: parseInt(days),
        from: daysAgo.toISOString(),
        to: new Date().toISOString()
      },
      summary: {
        total_uploads: totalUploads,
        total_storage_bytes: totalStorage,
        total_storage_mb: (totalStorage / (1024 * 1024)).toFixed(2),
        total_shares: totalShares,
        total_accesses: totalAccesses,
        successful_accesses: successfulAccesses,
        failed_accesses: totalAccesses - successfulAccesses
      },
      file_types: fileTypes,
      daily_trends: Object.entries(dailyTrends).map(([date, stats]) => ({
        date,
        uploads: stats.count,
        size_bytes: stats.size
      })),
      top_files: topFiles
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Get download trends
router.get('/downloads', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { days = 30 } = req.query;

    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.setDate() - parseInt(days));

    // Get user's share links
    const { data: shareLinks } = await supabaseAdmin
      .from('share_links')
      .select('id')
      .eq('user_id', userId);

    const linkIds = shareLinks?.map(link => link.id) || [];

    if (linkIds.length === 0) {
      return res.json({
        total_downloads: 0,
        by_day: [],
        by_hour: []
      });
    }

    // Get access logs
    const { data: accessLogs } = await supabaseAdmin
      .from('access_logs')
      .select('accessed_at, success')
      .in('share_link_id', linkIds)
      .eq('success', true)
      .gte('accessed_at', daysAgo.toISOString())
      .order('accessed_at', { ascending: true });

    // Group by day
    const byDay = {};
    accessLogs?.forEach(log => {
      const date = new Date(log.accessed_at).toISOString().split('T')[0];
      byDay[date] = (byDay[date] || 0) + 1;
    });

    // Group by hour of day (0-23)
    const byHour = Array(24).fill(0);
    accessLogs?.forEach(log => {
      const hour = new Date(log.accessed_at).getHours();
      byHour[hour]++;
    });

    res.json({
      total_downloads: accessLogs?.length || 0,
      by_day: Object.entries(byDay).map(([date, count]) => ({
        date,
        downloads: count
      })),
      by_hour: byHour.map((count, hour) => ({
        hour,
        downloads: count
      }))
    });
  } catch (error) {
    console.error('Error fetching download trends:', error);
    res.status(500).json({ error: 'Failed to fetch download trends' });
  }
});

// Get geographic data (based on IP - simplified version)
router.get('/geography', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user's share links
    const { data: shareLinks } = await supabaseAdmin
      .from('share_links')
      .select('id')
      .eq('user_id', userId);

    const linkIds = shareLinks?.map(link => link.id) || [];

    if (linkIds.length === 0) {
      return res.json({
        unique_ips: 0,
        top_ips: []
      });
    }

    // Get access logs with IP addresses
    const { data: accessLogs } = await supabaseAdmin
      .from('access_logs')
      .select('ip_address, accessed_at')
      .in('share_link_id', linkIds)
      .not('ip_address', 'is', null);

    // Count by IP
    const ipCounts = {};
    accessLogs?.forEach(log => {
      ipCounts[log.ip_address] = (ipCounts[log.ip_address] || 0) + 1;
    });

    const topIPs = Object.entries(ipCounts)
      .map(([ip, count]) => ({ ip, accesses: count }))
      .sort((a, b) => b.accesses - a.accesses)
      .slice(0, 10);

    res.json({
      unique_ips: Object.keys(ipCounts).length,
      total_accesses: accessLogs?.length || 0,
      top_ips: topIPs
    });
  } catch (error) {
    console.error('Error fetching geography data:', error);
    res.status(500).json({ error: 'Failed to fetch geography data' });
  }
});

// Get storage usage over time
router.get('/storage', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get all user's files
    const { data: files } = await supabaseAdmin
      .from('uploaded_files')
      .select('uploaded_at, file_size, expires_at')
      .eq('user_id', userId)
      .order('uploaded_at', { ascending: true });

    // Calculate cumulative storage over time
    const storageTimeline = [];
    let cumulativeSize = 0;

    files?.forEach(file => {
      cumulativeSize += file.file_size;
      storageTimeline.push({
        date: new Date(file.uploaded_at).toISOString().split('T')[0],
        cumulative_bytes: cumulativeSize,
        cumulative_mb: (cumulativeSize / (1024 * 1024)).toFixed(2)
      });
    });

    // Current storage
    const currentFiles = files?.filter(f => new Date(f.expires_at) > new Date()) || [];
    const currentStorage = currentFiles.reduce((sum, f) => sum + f.file_size, 0);

    res.json({
      current_storage_bytes: currentStorage,
      current_storage_mb: (currentStorage / (1024 * 1024)).toFixed(2),
      current_storage_gb: (currentStorage / (1024 * 1024 * 1024)).toFixed(2),
      active_files: currentFiles.length,
      total_files_uploaded: files?.length || 0,
      storage_timeline: storageTimeline
    });
  } catch (error) {
    console.error('Error fetching storage data:', error);
    res.status(500).json({ error: 'Failed to fetch storage data' });
  }
});

// Get share link performance
router.get('/share-performance', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: shareLinks } = await supabaseAdmin
      .from('share_links')
      .select(`
        id,
        created_at,
        expires_at,
        current_opens,
        max_opens,
        password_hash,
        require_otp,
        qr_code_enabled
      `)
      .eq('user_id', userId);

    if (!shareLinks || shareLinks.length === 0) {
      return res.json({
        total_links: 0,
        active_links: 0,
        expired_links: 0,
        password_protected: 0,
        otp_protected: 0,
        qr_enabled: 0
      });
    }

    const now = new Date();
    const activeLinks = shareLinks.filter(link => new Date(link.expires_at) > now);
    const expiredLinks = shareLinks.filter(link => new Date(link.expires_at) <= now);
    const passwordProtected = shareLinks.filter(link => link.password_hash);
    const otpProtected = shareLinks.filter(link => link.require_otp);
    const qrEnabled = shareLinks.filter(link => link.qr_code_enabled);

    res.json({
      total_links: shareLinks.length,
      active_links: activeLinks.length,
      expired_links: expiredLinks.length,
      password_protected: passwordProtected.length,
      otp_protected: otpProtected.length,
      qr_enabled: qrEnabled.length,
      avg_opens_per_link: (
        shareLinks.reduce((sum, link) => sum + link.current_opens, 0) / shareLinks.length
      ).toFixed(2)
    });
  } catch (error) {
    console.error('Error fetching share performance:', error);
    res.status(500).json({ error: 'Failed to fetch share performance' });
  }
});

export default router;

