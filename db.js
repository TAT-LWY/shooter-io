const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Create tables on startup
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(12) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        kills INT DEFAULT 0,
        deaths INT DEFAULT 0,
        games_played INT DEFAULT 0,
        best_kill_streak INT DEFAULT 0,
        total_play_time INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        last_login TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('Database tables ready');
  } catch (err) {
    console.error('Database init error:', err.message);
  }
}

module.exports = { pool, initDB };
