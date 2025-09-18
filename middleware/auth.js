const { supabase } = require('../config/database');
const { getTierLimits } = require('../utils/tierLimits');

// Detect user tier (anonymous vs authenticated)
const detectUserTier = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  // Add CORS headers for preflight requests
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
  res.header('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.userTier = 'free';
    req.userId = null;
    req.isAuthenticated = false;
    req.tierLimits = getTierLimits('free');
    return next();
  }
  
  try {
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      req.userTier = 'free';
      req.userId = null;
      req.isAuthenticated = false;
      req.tierLimits = getTierLimits('free');
      return next();
    }
    
    // Get user tier from Supabase user metadata or database
    let userTier = 'free'; // Default to free tier for all users
    
    // Try to get tier from user metadata first
    if (user.user_metadata?.tier) {
      userTier = user.user_metadata.tier;
    } else {
      // Fallback: check users table in our database
      try {
        const { data: userData } = await supabase
          .from('users')
          .select('plan_type')
          .eq('id', user.id)
          .single();
        
        if (userData?.plan_type === 'paid') {
          userTier = 'pro'; // Only set to pro if explicitly paid
        }
      } catch (dbError) {
        console.warn('Could not fetch user tier from database:', dbError);
      }
    }
    
    req.user = user;
    req.userId = user.id;
    req.userEmail = user.email;
    req.userTier = userTier;
    req.isAuthenticated = true;
    req.tierLimits = getTierLimits(userTier);
    
  } catch (error) {
    console.error('Auth middleware error:', error);
    req.userTier = 'free';
    req.userId = null;
    req.isAuthenticated = false;
    req.tierLimits = getTierLimits('free');
  }
  
  next();
};

// Require authentication
const requireAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      error: 'Authentication required',
      code: 'AUTH_REQUIRED'
    });
  }
  
  try {
    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      return res.status(401).json({ 
        error: 'Invalid or expired token',
        code: 'INVALID_TOKEN'
      });
    }
    
    // Get user tier
    let userTier = 'free';
    if (user.user_metadata?.tier) {
      userTier = user.user_metadata.tier;
    } else {
      try {
        const { data: userData } = await supabase
          .from('users')
          .select('plan_type')
          .eq('id', user.id)
          .single();
        
        if (userData?.plan_type === 'paid') {
          userTier = 'pro';
        }
      } catch (dbError) {
        console.warn('Could not fetch user tier from database:', dbError);
      }
    }
    
    req.user = user;
    req.userId = user.id;
    req.userEmail = user.email;
    req.userTier = userTier;
    req.isAuthenticated = true;
    req.tierLimits = getTierLimits(userTier);
    
    next();
  } catch (error) {
    console.error('Auth verification error:', error);
    return res.status(401).json({ 
      error: 'Authentication failed',
      code: 'AUTH_FAILED'
    });
  }
};

// Require specific tier
const requireTier = (minimumTier) => {
  const tierHierarchy = { free: 0, pro: 1, business: 2 };
  
  return (req, res, next) => {
    const userTierLevel = tierHierarchy[req.userTier] || 0;
    const requiredTierLevel = tierHierarchy[minimumTier] || 0;
    
    if (userTierLevel < requiredTierLevel) {
      return res.status(403).json({
        error: `This feature requires ${minimumTier} tier or higher`,
        currentTier: req.userTier,
        requiredTier: minimumTier,
        code: 'INSUFFICIENT_TIER'
      });
    }
    
    next();
  };
};

module.exports = {
  detectUserTier,
  requireAuth,
  requireTier
};
