import express from 'express';
import { supabaseAdmin } from '../../config/supabase.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Get lifetime deal counter status
router.get('/counter', async (req, res) => {
  try {
    logger.info('Fetching lifetime deal counter');
    
    const { data, error } = await supabaseAdmin
      .rpc('get_lifetime_deal_counter');
    
    if (error) {
      logger.error('Error fetching lifetime deal counter', { error });
      throw error;
    }
    
    // If no counter exists yet, return default values
    if (!data || data.length === 0) {
      logger.warn('No lifetime deal counter found, returning defaults');
      return res.json({
        total_sold: 10,
        max_limit: 100,
        is_available: true,
        remaining: 90
      });
    }
    
    const counterData = data[0];
    const remaining = counterData.max_limit - counterData.total_sold;
    
    logger.info('Lifetime deal counter fetched', { 
      total_sold: counterData.total_sold, 
      max_limit: counterData.max_limit,
      is_available: counterData.is_available,
      remaining
    });
    
    res.json({
      total_sold: counterData.total_sold,
      max_limit: counterData.max_limit,
      is_available: counterData.is_available,
      remaining: remaining
    });
    
  } catch (error) {
    logger.error('Failed to fetch lifetime deal counter', { 
      error: error.message,
      stack: error.stack 
    });
    
    res.status(500).json({ 
      error: 'Failed to fetch lifetime deal counter',
      message: error.message 
    });
  }
});

// Increment lifetime deal counter (internal use only - called by webhook)
router.post('/increment', async (req, res) => {
  try {
    logger.info('Incrementing lifetime deal counter');
    
    const { data, error } = await supabaseAdmin
      .rpc('increment_lifetime_deal_counter');
    
    if (error) {
      logger.error('Error incrementing lifetime deal counter', { error });
      throw error;
    }
    
    logger.info('Lifetime deal counter incremented', { new_count: data });
    
    res.json({
      success: true,
      total_sold: data,
      message: 'Lifetime deal counter incremented successfully'
    });
    
  } catch (error) {
    logger.error('Failed to increment lifetime deal counter', { 
      error: error.message,
      stack: error.stack 
    });
    
    res.status(500).json({ 
      error: 'Failed to increment lifetime deal counter',
      message: error.message 
    });
  }
});

export default router;

