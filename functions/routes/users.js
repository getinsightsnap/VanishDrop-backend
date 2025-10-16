import express from 'express';
import { supabaseAdmin } from '../../config/supabase.js';
import { authMiddleware } from '../middleware/auth.js';
import { validateSubscriptionUpdate } from '../middleware/validators.js';

const router = express.Router();

// Get current user profile
router.get('/profile', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', req.user.id)
      .single();

    if (error) throw error;

    res.json({ user: data });
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// Update subscription tier
router.patch('/subscription', authMiddleware, validateSubscriptionUpdate, async (req, res) => {
  try {
    const { subscription_tier } = req.body;

    if (!['free', 'pro'].includes(subscription_tier)) {
      return res.status(400).json({ error: 'Invalid subscription tier' });
    }

    const { data, error } = await supabaseAdmin
      .from('users')
      .update({ subscription_tier })
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) throw error;

    res.json({ user: data });
  } catch (error) {
    console.error('Error updating subscription:', error);
    res.status(500).json({ error: 'Failed to update subscription' });
  }
});

// Start trial
router.post('/trial', authMiddleware, async (req, res) => {
  try {
    const { data: userData, error: fetchError } = await supabaseAdmin
      .from('users')
      .select('trial_used')
      .eq('id', req.user.id)
      .single();

    if (fetchError) throw fetchError;

    if (userData.trial_used) {
      return res.status(400).json({ error: 'Trial already used' });
    }

    const trialEndDate = new Date();
    trialEndDate.setDate(trialEndDate.getDate() + 7);

    const { data, error } = await supabaseAdmin
      .from('users')
      .update({
        subscription_tier: 'pro',
        trial_used: true,
        trial_end_date: trialEndDate.toISOString()
      })
      .eq('id', req.user.id)
      .select()
      .single();

    if (error) throw error;

    res.json({ user: data });
  } catch (error) {
    console.error('Error starting trial:', error);
    res.status(500).json({ error: 'Failed to start trial' });
  }
});

// Get user upload usage
router.get('/usage', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user's subscription tier
    const { data: userData, error: userError } = await supabaseAdmin
      .from('users')
      .select('subscription_tier')
      .eq('id', userId)
      .single();

    if (userError) throw userError;

    // Get all uploaded files
    const { data: files, error: filesError } = await supabaseAdmin
      .from('uploaded_files')
      .select('file_size, created_at')
      .eq('user_id', userId);

    if (filesError) throw filesError;

    let usage = 0;
    
    if (userData.subscription_tier === 'pro') {
      // Pro users: Daily usage (last 24 hours)
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const dailyFiles = files?.filter(file => 
        new Date(file.created_at) > oneDayAgo
      ) || [];
      usage = dailyFiles.reduce((sum, file) => sum + file.file_size, 0);
    } else {
      // Free users: Lifetime usage (all files)
      usage = files?.reduce((sum, file) => sum + file.file_size, 0) || 0;
    }

    res.json({
      usage,
      subscription_tier: userData.subscription_tier
    });
  } catch (error) {
    console.error('Error fetching usage:', error);
    res.status(500).json({ error: 'Failed to fetch usage' });
  }
});

// Get user statistics
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get file count
    const { count: fileCount, error: fileError } = await supabaseAdmin
      .from('uploaded_files')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (fileError) throw fileError;

    // Get share link count
    const { count: linkCount, error: linkError } = await supabaseAdmin
      .from('share_links')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    if (linkError) throw linkError;

    // Get total access count
    const { data: accessData, error: accessError } = await supabaseAdmin
      .from('access_logs')
      .select('share_link_id')
      .in('share_link_id', 
        supabaseAdmin
          .from('share_links')
          .select('id')
          .eq('user_id', userId)
      );

    if (accessError) throw accessError;

    res.json({
      stats: {
        total_files: fileCount || 0,
        total_links: linkCount || 0,
        total_accesses: accessData?.length || 0
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Check and reset daily limit
router.post('/reset-daily-limit', authMiddleware, async (req, res) => {
  try {
    const { data: userData, error: fetchError } = await supabaseAdmin
      .from('users')
      .select('daily_upload_used, daily_upload_reset_at')
      .eq('id', req.user.id)
      .single();

    if (fetchError) throw fetchError;

    const resetTime = new Date(userData.daily_upload_reset_at);
    const now = new Date();
    const hoursPassed = (now.getTime() - resetTime.getTime()) / (1000 * 60 * 60);

    if (hoursPassed >= 24) {
      const { data, error } = await supabaseAdmin
        .from('users')
        .update({
          daily_upload_used: 0,
          daily_upload_reset_at: now.toISOString()
        })
        .eq('id', req.user.id)
        .select()
        .single();

      if (error) throw error;

      return res.json({ user: data, reset: true });
    }

    res.json({ user: userData, reset: false });
  } catch (error) {
    console.error('Error resetting daily limit:', error);
    res.status(500).json({ error: 'Failed to reset daily limit' });
  }
});

export default router;
