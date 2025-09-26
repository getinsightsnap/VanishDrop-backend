const express = require('express');
const { supabase } = require('../config/database');
const { deleteFile } = require('../utils/fileUtils');
const { requireTier } = require('../middleware/auth');

const router = express.Router();

// Get user's active drops
router.get('/drops', async (req, res) => {
  try {
    const { page = 1, limit = 20, status = 'active' } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('drops')
      .select('id, token, type, original_filename, file_size, mimetype, expires_at, view_count, download_count, protection_type, created_at, last_accessed, max_access_count')
      .eq('user_id', req.userId);

    if (status === 'active') {
      query = query.gt('expires_at', new Date().toISOString()).eq('view_count', 0);
    } else if (status === 'expired') {
      query = query.or(`expires_at.lte.${new Date().toISOString()},view_count.gte.max_access_count`);
    }

    const { data: drops, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      throw new Error(`Failed to fetch drops: ${error.message}`);
    }

    const formattedDrops = drops.map(drop => ({
      ...drop,
      shareUrl: `${process.env.FRONTEND_URL}/f/${drop.token}`,
      isExpired: new Date() > new Date(drop.expires_at) || drop.view_count >= drop.max_access_count
    }));

    res.json({
      drops: formattedDrops,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      }
    });

  } catch (error) {
    console.error('Get user drops error:', error);
    res.status(500).json({
      error: 'Failed to fetch drops',
      code: 'FETCH_ERROR'
    });
  }
});

// Get user statistics
router.get('/stats', async (req, res) => {
  try {
    // Get user stats
    const { data: userStats, error: statsError } = await supabase
      .from('user_stats')
      .select('*')
      .eq('user_id', req.userId)
      .single();

    let stats = {
      totalUploads: 0,
      totalDownloads: 0,
      storageUsed: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (userStats && !statsError) {
      stats = {
        totalUploads: userStats.total_uploads,
        totalDownloads: userStats.total_downloads,
        storageUsed: userStats.storage_used,
        createdAt: userStats.created_at,
        updatedAt: userStats.updated_at
      };
    }

    // Get additional analytics (Pro/Business only)
    if (req.tierLimits.allowAnalytics) {
      const now = new Date().toISOString();
      
      // Get active drops count
      const { count: activeDrops } = await supabase
        .from('drops')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', req.userId)
        .gt('expires_at', now)
        .eq('view_count', 0);

      // Get expired drops count
      const { count: expiredDrops } = await supabase
        .from('drops')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', req.userId)
        .or(`expires_at.lte.${now},view_count.gte.max_access_count`);

      // Get average downloads and last upload
      const { data: analyticsData } = await supabase
        .from('drops')
        .select('download_count, created_at')
        .eq('user_id', req.userId);

      const avgDownloads = analyticsData?.length > 0 
        ? analyticsData.reduce((sum, drop) => sum + (drop.download_count || 0), 0) / analyticsData.length 
        : 0;

      const lastUpload = analyticsData?.length > 0 
        ? analyticsData.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0].created_at
        : null;

      stats.analytics = {
        activeDrops: activeDrops || 0,
        expiredDrops: expiredDrops || 0,
        avgDownloadsPerDrop: avgDownloads,
        lastUpload
      };
    }

    res.json({
      stats,
      tier: req.userTier,
      limits: req.tierLimits
    });

  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({
      error: 'Failed to fetch statistics',
      code: 'STATS_ERROR'
    });
  }
});

// Delete user's drop
router.delete('/drop/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Find the drop
    const { data: drop, error: dropError } = await supabase
      .from('drops')
      .select('*')
      .eq('id', id)
      .eq('user_id', req.userId)
      .single();

    if (dropError || !drop) {
      return res.status(404).json({
        error: 'Drop not found or not owned by user',
        code: 'DROP_NOT_FOUND'
      });
    }

    // Delete file from Supabase Storage if exists
    if (drop.file_path && drop.type === 'file') {
      try {
        await supabase.storage
          .from('vanish-drop-files')
          .remove([drop.file_path]);
      } catch (storageError) {
        console.warn('Failed to delete file from storage:', storageError);
      }
    }

    // Delete from database
    const { error: deleteError } = await supabase
      .from('drops')
      .delete()
      .eq('id', id);

    if (deleteError) {
      throw new Error(`Failed to delete drop: ${deleteError.message}`);
    }

    // Update user stats
    const { error: statsError } = await supabase
      .from('user_stats')
      .update({
        total_uploads: Math.max(0, (await supabase.from('user_stats').select('total_uploads').eq('user_id', req.userId).single()).data?.total_uploads - 1 || 0),
        storage_used: Math.max(0, (await supabase.from('user_stats').select('storage_used').eq('user_id', req.userId).single()).data?.storage_used - (drop.file_size || 0) || 0),
        updated_at: new Date().toISOString()
      })
      .eq('user_id', req.userId);

    if (statsError) {
      console.warn('Failed to update user stats:', statsError);
    }

    res.json({
      success: true,
      message: 'Drop deleted successfully'
    });

  } catch (error) {
    console.error('Delete drop error:', error);
    res.status(500).json({
      error: 'Failed to delete drop',
      code: 'DELETE_ERROR'
    });
  }
});

// Create file request portal (Business tier only)
router.post('/request', requireTier('business'), async (req, res) => {
  try {
    const { title, maxFiles = 10, maxFileSize, expirationHours = 24, notificationEmail, webhookUrl } = req.body;

    if (!title) {
      return res.status(400).json({
        error: 'Title is required',
        code: 'MISSING_TITLE'
      });
    }

    const { generateToken } = require('../utils/fileUtils');
    const token = generateToken(16);
    const expiresAt = new Date(Date.now() + (expirationHours * 60 * 60 * 1000));

    const { data: portal, error } = await supabase
      .from('request_portals')
      .insert({
        token,
        user_id: req.userId,
        title,
        max_files: maxFiles,
        max_file_size: maxFileSize,
        expires_at: expiresAt.toISOString(),
        notification_email: notificationEmail,
        webhook_url: webhookUrl
      })
      .select('id, token, expires_at')
      .single();

    if (error) {
      throw new Error(`Failed to create request portal: ${error.message}`);
    }

    res.status(201).json({
      success: true,
      portal: {
        id: portal.id,
        token: portal.token,
        title,
        maxFiles,
        maxFileSize,
        expiresAt: portal.expires_at,
        shareUrl: `${process.env.FRONTEND_URL}/request/${portal.token}`,
        notificationEmail,
        webhookUrl
      }
    });

  } catch (error) {
    console.error('Create request portal error:', error);
    res.status(500).json({
      error: 'Failed to create request portal',
      code: 'REQUEST_PORTAL_ERROR'
    });
  }
});

// Get user's request portals (Business tier only)
router.get('/requests', requireTier('business'), async (req, res) => {
  try {
    const { data: portals, error } = await supabase
      .from('request_portals')
      .select('id, token, title, max_files, max_file_size, expires_at, files_received, notification_email, webhook_url, created_at')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch request portals: ${error.message}`);
    }

    const formattedPortals = portals.map(portal => ({
      ...portal,
      shareUrl: `${process.env.FRONTEND_URL}/request/${portal.token}`,
      isExpired: new Date() > new Date(portal.expires_at)
    }));

    res.json({ portals: formattedPortals });

  } catch (error) {
    console.error('Get request portals error:', error);
    res.status(500).json({
      error: 'Failed to fetch request portals',
      code: 'FETCH_PORTALS_ERROR'
    });
  }
});

module.exports = router;
