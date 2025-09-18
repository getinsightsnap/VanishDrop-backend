const express = require('express');
const { getTierLimits } = require('../utils/tierLimits');

const router = express.Router();

// Get tier information and limits
router.get('/tiers', (req, res) => {
  console.log('📊 Tiers endpoint accessed from public.js');
  
  const tiers = {
    free: {
      ...getTierLimits('free'),
      name: 'Free',
      price: 0,
      description: 'Basic file sharing for personal use'
    },
    pro: {
      ...getTierLimits('pro'),
      name: 'Pro',
      price: 8.99,
      description: 'Advanced features for professionals'
    },
    business: {
      ...getTierLimits('business'),
      name: 'Business',
      price: 29.99,
      description: 'Full features for teams and organizations'
    }
  };

  res.json({
    tiers,
    currency: 'USD',
    billing: 'monthly'
  });
});

// Get server status and version
router.get('/status', (req, res) => {
  res.json({
    status: 'operational',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    features: {
      fileSharing: true,
      messageSharing: true,
      qrGeneration: true,
      passwordProtection: true,
      otpProtection: true,
      userDashboard: true,
      apiAccess: true
    }
  });
});

module.exports = router;