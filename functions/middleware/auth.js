import { supabase } from '../../config/supabase.js';

export const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    console.log('🔐 Auth check:', {
      hasAuthHeader: !!authHeader,
      headerPreview: authHeader ? authHeader.substring(0, 30) + '...' : 'none',
      path: req.path
    });

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.error('❌ Invalid auth header:', authHeader);
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }

    const token = authHeader.substring(7);

    // Verify the JWT token
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Attach user to request
    req.user = user;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
};

export default authMiddleware;
