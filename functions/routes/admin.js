import express from 'express';
import { supabaseAdmin } from '../../config/supabase.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// Middleware to check if user is admin
const adminMiddleware = async (req, res, next) => {
  try {
    const { data: userData, error } = await supabaseAdmin
      .from('users')
      .select('email, subscription_tier')
      .eq('id', req.user.id)
      .single();

    if (error) throw error;

    // Check if user is admin (you can modify this logic)
    // For now, checking if email is in admin list from environment variable
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim());
    
    if (!adminEmails.includes(userData.email)) {
      return res.status(403).json({ error: 'Access denied. Admin privileges required.' });
    }

    next();
  } catch (error) {
    console.error('Admin check error:', error);
    res.status(403).json({ error: 'Access denied' });
  }
};

// Get all users (paginated)
router.get('/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    const offset = (page - 1) * limit;

    let query = supabaseAdmin
      .from('users')
      .select('*', { count: 'exact' });

    if (search) {
      query = query.ilike('email', `%${search}%`);
    }

    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (error) throw error;

    res.json({
      users: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get user details by ID
router.get('/users/:userId', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: userData, error: userError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    if (userError) throw userError;

    // Get user's file count
    const { count: fileCount } = await supabaseAdmin
      .from('uploaded_files')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    // Get user's share link count
    const { count: linkCount } = await supabaseAdmin
      .from('share_links')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    res.json({
      user: userData,
      stats: {
        total_files: fileCount || 0,
        total_links: linkCount || 0
      }
    });
  } catch (error) {
    console.error('Error fetching user details:', error);
    res.status(500).json({ error: 'Failed to fetch user details' });
  }
});

// Update user subscription (admin)
router.patch('/users/:userId/subscription', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const { subscription_tier } = req.body;

    if (!['free', 'pro'].includes(subscription_tier)) {
      return res.status(400).json({ error: 'Invalid subscription tier' });
    }

    const { data, error } = await supabaseAdmin
      .from('users')
      .update({ 
        subscription_tier,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId)
      .select()
      .single();

    if (error) throw error;

    res.json({ 
      user: data,
      message: 'Subscription updated successfully'
    });
  } catch (error) {
    console.error('Error updating subscription:', error);
    res.status(500).json({ error: 'Failed to update subscription' });
  }
});

// Delete user (admin)
router.delete('/users/:userId', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;

    // Get user's files to delete from storage
    const { data: files } = await supabaseAdmin
      .from('uploaded_files')
      .select('file_url, user_id')
      .eq('user_id', userId);

    // Delete files from storage
    if (files && files.length > 0) {
      const filePaths = files.map(f => {
        const url = f.file_url;
        const parts = url.split('/');
        return `${f.user_id}/${parts[parts.length - 1]}`;
      });

      await supabaseAdmin.storage
        .from('user-files')
        .remove(filePaths);
    }

    // Delete user (cascade will delete files and share links)
    const { error } = await supabaseAdmin
      .from('users')
      .delete()
      .eq('id', userId);

    if (error) throw error;

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Get platform statistics
router.get('/stats', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    // Total users
    const { count: totalUsers } = await supabaseAdmin
      .from('users')
      .select('*', { count: 'exact', head: true });

    // Pro users
    const { count: proUsers } = await supabaseAdmin
      .from('users')
      .select('*', { count: 'exact', head: true })
      .eq('subscription_tier', 'pro');

    // Total files
    const { count: totalFiles } = await supabaseAdmin
      .from('uploaded_files')
      .select('*', { count: 'exact', head: true });

    // Total share links
    const { count: totalLinks } = await supabaseAdmin
      .from('share_links')
      .select('*', { count: 'exact', head: true });

    // Total accesses
    const { count: totalAccesses } = await supabaseAdmin
      .from('access_logs')
      .select('*', { count: 'exact', head: true });

    // Total storage used (sum of all file sizes)
    const { data: storageData } = await supabaseAdmin
      .from('uploaded_files')
      .select('file_size');

    const totalStorage = storageData?.reduce((sum, file) => sum + (file.file_size || 0), 0) || 0;

    // Recent users (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const { count: recentUsers } = await supabaseAdmin
      .from('users')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', sevenDaysAgo.toISOString());

    res.json({
      stats: {
        total_users: totalUsers || 0,
        pro_users: proUsers || 0,
        free_users: (totalUsers || 0) - (proUsers || 0),
        total_files: totalFiles || 0,
        total_links: totalLinks || 0,
        total_accesses: totalAccesses || 0,
        total_storage_bytes: totalStorage,
        total_storage_gb: (totalStorage / (1024 * 1024 * 1024)).toFixed(2),
        recent_users_7days: recentUsers || 0
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Get all files (paginated)
router.get('/files', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const { data, error, count } = await supabaseAdmin
      .from('uploaded_files')
      .select(`
        *,
        users!inner (email)
      `, { count: 'exact' })
      .order('uploaded_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (error) throw error;

    res.json({
      files: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching files:', error);
    res.status(500).json({ error: 'Failed to fetch files' });
  }
});

// Get all share links (paginated)
router.get('/links', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const { data, error, count } = await supabaseAdmin
      .from('share_links')
      .select(`
        *,
        users!inner (email),
        uploaded_files (filename)
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1);

    if (error) throw error;

    res.json({
      links: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching links:', error);
    res.status(500).json({ error: 'Failed to fetch links' });
  }
});

// Get recent activity (access logs)
router.get('/activity', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { limit = 50 } = req.query;

    const { data, error } = await supabaseAdmin
      .from('access_logs')
      .select(`
        *,
        share_links!inner (
          share_token,
          uploaded_files (filename),
          users (email)
        )
      `)
      .order('accessed_at', { ascending: false })
      .limit(parseInt(limit));

    if (error) throw error;

    res.json({ activity: data });
  } catch (error) {
    console.error('Error fetching activity:', error);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

export default router;

