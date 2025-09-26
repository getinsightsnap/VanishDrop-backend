const { supabase } = require('../config/database');

// Simple in-memory rate limiter for basic protection
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const MAX_REQUESTS = 100;

// General rate limiter middleware
const rateLimitMiddleware = (req, res, next) => {
  const key = req.ip;
  const now = Date.now();
  
  // Clean old entries
  for (const [ip, data] of requestCounts.entries()) {
    if (now - data.firstRequest > RATE_LIMIT_WINDOW) {
      requestCounts.delete(ip);
    }
  }
  
  // Check current IP
  const ipData = requestCounts.get(key);
  if (!ipData) {
    requestCounts.set(key, { count: 1, firstRequest: now });
    return next();
  }
  
  if (now - ipData.firstRequest > RATE_LIMIT_WINDOW) {
    // Reset window
    requestCounts.set(key, { count: 1, firstRequest: now });
    return next();
  }
  
  if (ipData.count >= MAX_REQUESTS) {
    return res.status(429).json({
      error: 'Too many requests',
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Please slow down and try again later'
    });
  }
  
  ipData.count++;
  next();
};

// Check free tier upload limits (5 uploads per IP)
const checkFreeTierLimits = async (req, res, next) => {
  if (req.userTier !== 'free') {
    return next(); // Skip for authenticated users
  }

  try {
    const ip = req.ip;
    const maxUploads = parseInt(process.env.FREE_TIER_LIFETIME_UPLOADS) || 5;

    // Check current usage
    const { data: usageData, error: usageError } = await supabase
      .from('ip_usage')
      .select('total_uploads, is_blocked')
      .eq('ip_address', ip)
      .single();

    if (usageError && usageError.code !== 'PGRST116') { // PGRST116 = no rows found
      console.error('Error checking IP usage:', usageError);
      return next(); // Continue on error to avoid blocking legitimate users
    }

    if (!usageData) {
      // First upload from this IP
      const { error: insertError } = await supabase
        .from('ip_usage')
        .insert({
          ip_address: ip,
          total_uploads: 0
        });

      if (insertError) {
        console.error('Error creating IP usage record:', insertError);
      }
      return next();
    }

    const usage = usageData;

    if (usage.is_blocked) {
      return res.status(403).json({
        error: 'IP address is blocked due to abuse',
        code: 'IP_BLOCKED'
      });
    }

    if (usage.total_uploads >= maxUploads) {
      return res.status(403).json({
        error: `Free tier limit reached. Maximum ${maxUploads} uploads per IP address.`,
        code: 'FREE_TIER_LIMIT_EXCEEDED',
        currentUploads: usage.total_uploads,
        maxUploads: maxUploads,
        tier_limits_reached: true,
        upgradeMessage: 'Upgrade to Pro or Business tier for unlimited uploads'
      });
    }

    // Store usage info in request for later use
    req.ipUsage = usage;
    next();
  } catch (error) {
    console.error('Error checking free tier limits:', error);
    next(); // Continue on error to avoid blocking legitimate users
  }
};

// Increment free tier usage counter
const incrementFreeTierUsage = async (ip) => {
  try {
    const { error } = await supabase
      .from('ip_usage')
      .upsert({
        ip_address: ip,
        total_uploads: 1,
        last_upload: new Date().toISOString()
      }, {
        onConflict: 'ip_address',
        ignoreDuplicates: false
      });

    if (error) {
      console.error('Error incrementing free tier usage:', error);
    }
  } catch (error) {
    console.error('Error incrementing free tier usage:', error);
  }
};

module.exports = {
  rateLimitMiddleware,
  checkFreeTierLimits,
  incrementFreeTierUsage
};
