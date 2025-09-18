const Redis = require('ioredis');

let redis;

async function initializeRedis() {
  try {
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      retryDelayOnFailover: 100,
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
    });

    redis.on('connect', () => {
      console.log('✅ Redis connected');
    });

    redis.on('error', (err) => {
      console.error('❌ Redis error:', err);
    });

    // Test connection
    await redis.ping();
    
    return redis;
  } catch (error) {
    console.error('❌ Redis initialization failed:', error);
    throw error;
  }
}

function getRedisClient() {
  if (!redis) {
    throw new Error('Redis not initialized. Call initializeRedis() first.');
  }
  return redis;
}

module.exports = {
  initializeRedis,
  getRedisClient
};