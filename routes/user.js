const express = require('express');
const { pool } = require('../config/database');
const { deleteFile } = require('../utils/fileUtils');
const { requireTier } = require('../middleware/auth');

const router = express.Router();

// Get user's active drops
router.get('/drops', async (req, res) => {
  try {
    const { page = 1, limit = 20, status = 'active' } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE user_id = $1';
    let queryParams = [req.userId];

    if (status === 'active') {
      whereClause += ' AND expires_at > NOW() AND view_count = 0';
    } else if (status === 'expired') {
      whereClause += ' AND (expires_at <= NOW() OR view_count >= 1)';
    }

    const dropsResult = await pool.query(`
      SELECT 
        id, token, type, original_filename, file_size, mimetype,
        expires_at, view_count, download_count, protection_type,
        created_at, last_accessed
      FROM drops 
      ${whereClause}
      ORDER BY created_at DESC 
      LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}
    `, [...queryParams, limit, offset]);

    // Get total count
    const countResult = await pool.query(`
      SELECT COUNT(*) as total FROM drops ${whereClause}
    `, queryParams);

    const drops = dropsResult.rows.map(drop => ({
      ...drop,
      shareUrl: `${process.env.FRONTEND_URL}/f/${drop.token}`,
      isExpired: new Date() > new Date(drop.expires_at) || drop.view_count >= 1
    }));

    res.json({
      drops,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].total),
        totalPages: Math.ceil(countResult.rows[0].total / limit)
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
    const statsResult = await pool.query(
      'SELECT * FROM user_stats WHERE user_id = $1',
      [req.userId]
    );

    let stats = {
      totalUploads: 0,
      totalDownloads: 0,
      storageUsed: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (statsResult.rows.length > 0) {
      const userStats = statsResult.rows[0];
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
      const analyticsResult = await pool.query(`
        SELECT 
          COUNT(*) as active_drops,
          COUNT(CASE WHEN expires_at <= NOW() OR view_count >= 1 THEN 1 END) as expired_drops,
          AVG(download_count) as avg_downloads_per_drop,
          MAX(created_at) as last_upload
        FROM drops 
        WHERE user_id = $1
      `, [req.userId]);

      if (analyticsResult.rows.length > 0) {
        const analytics = analyticsResult.rows[0];
        stats.analytics = {
          activeDrops: parseInt(analytics.active_drops),
          expiredDrops: parseInt(analytics.expired_drops),
          avgDownloadsPerDrop: parseFloat(analytics.avg_downloads_per_drop) || 0,
          lastUpload: analytics.last_upload
        };
      }
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
    const dropResult = await pool.query(
      'SELECT * FROM drops WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );

    if (dropResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Drop not found or not owned by user',
        code: 'DROP_NOT_FOUND'
      });
    }

    const drop = dropResult.rows[0];

    // Delete file if exists
    if (drop.file_path && drop.type === 'file') {
      await deleteFile(drop.file_path);
    }

    // Delete from database
    await pool.query('DELETE FROM drops WHERE id = $1', [id]);

    // Update user stats
    await pool.query(`
      UPDATE user_stats 
      SET 
        total_uploads = GREATEST(total_uploads - 1, 0),
        storage_used = GREATEST(storage_used - $1, 0),
        updated_at = NOW()
      WHERE user_id = $2
    `, [drop.file_size, req.userId]);

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

    const result = await pool.query(`
      INSERT INTO request_portals (
        token, user_id, title, max_files, max_file_size, expires_at, 
        notification_email, webhook_url
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, token, expires_at
    `, [token, req.userId, title, maxFiles, maxFileSize, expiresAt, notificationEmail, webhookUrl]);

    const portal = result.rows[0];

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
    const result = await pool.query(`
      SELECT 
        id, token, title, max_files, max_file_size, expires_at,
        files_received, notification_email, webhook_url, created_at
      FROM request_portals 
      WHERE user_id = $1 
      ORDER BY created_at DESC
    `, [req.userId]);

    const portals = result.rows.map(portal => ({
      ...portal,
      shareUrl: `${process.env.FRONTEND_URL}/request/${portal.token}`,
      isExpired: new Date() > new Date(portal.expires_at)
    }));

    res.json({ portals });

  } catch (error) {
    console.error('Get request portals error:', error);
    res.status(500).json({
      error: 'Failed to fetch request portals',
      code: 'FETCH_PORTALS_ERROR'
    });
  }
});

module.exports = router;