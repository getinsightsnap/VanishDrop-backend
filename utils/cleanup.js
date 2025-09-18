const { pool } = require('../config/database');
const { deleteFile } = require('./fileUtils');

// Clean up expired drops
const cleanupExpiredDrops = async () => {
  try {
    const now = new Date();
    
    // Find expired drops
    const expiredDrops = await pool.query(`
      SELECT id, file_path, type, token 
      FROM drops 
      WHERE expires_at <= $1 OR view_count >= 1 
      ORDER BY expires_at ASC
    `, [now]);

    let cleanedCount = 0;

    for (const drop of expiredDrops.rows) {
      try {
        // Delete file if it exists
        if (drop.file_path && drop.type === 'file') {
          await deleteFile(drop.file_path);
        }

        // Delete from database
        await pool.query('DELETE FROM drops WHERE id = $1', [drop.id]);
        
        cleanedCount++;
        console.log(`🗑️  Cleaned expired drop: ${drop.token}`);
        
      } catch (error) {
        console.error(`❌ Failed to clean drop ${drop.token}:`, error);
      }
    }

    return cleanedCount;
  } catch (error) {
    console.error('❌ Cleanup job failed:', error);
    throw error;
  }
};

// Clean up old IP usage records (optional - run weekly)
const cleanupOldIPUsage = async () => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const result = await pool.query(`
      DELETE FROM ip_usage 
      WHERE first_upload < $1 AND total_uploads < 5
    `, [thirtyDaysAgo]);

    console.log(`🧹 Cleaned ${result.rowCount} old IP usage records`);
    return result.rowCount;
  } catch (error) {
    console.error('❌ IP usage cleanup failed:', error);
    throw error;
  }
};

module.exports = {
  cleanupExpiredDrops,
  cleanupOldIPUsage
};
