const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'shooter-io-secret-key-change-in-production';

// Register
router.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
    if (username.length < 2 || username.length > 12) return res.status(400).json({ error: '用户名需要2-12个字符' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少6个字符' });

    // Check if username exists
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) return res.status(400).json({ error: '用户名已存在' });

    const hashed = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id, username, kills, deaths, games_played, best_kill_streak',
      [username, hashed]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });

    res.json({
      token,
      user: {
        username: user.username,
        stats: {
          kills: user.kills,
          deaths: user.deaths,
          gamesPlayed: user.games_played,
          bestKillStreak: user.best_kill_streak
        }
      }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: '注册失败，请重试' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });

    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) return res.status(400).json({ error: '用户名或密码错误' });

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: '用户名或密码错误' });

    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });

    res.json({
      token,
      user: {
        username: user.username,
        stats: {
          kills: user.kills,
          deaths: user.deaths,
          gamesPlayed: user.games_played,
          bestKillStreak: user.best_kill_streak
        }
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: '登录失败，请重试' });
  }
});

// Get profile
router.get('/profile', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: '未登录' });

    const token = authHeader.replace('Bearer ', '');
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await pool.query(
      'SELECT username, kills, deaths, games_played, best_kill_streak, created_at FROM users WHERE id = $1',
      [decoded.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: '用户不存在' });

    const user = result.rows[0];
    res.json({
      username: user.username,
      stats: {
        kills: user.kills,
        deaths: user.deaths,
        gamesPlayed: user.games_played,
        bestKillStreak: user.best_kill_streak
      },
      createdAt: user.created_at
    });
  } catch (err) {
    res.status(401).json({ error: '登录已过期' });
  }
});

// Leaderboard
router.get('/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT username, kills, deaths, best_kill_streak FROM users ORDER BY kills DESC LIMIT 20'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: '获取排行榜失败' });
  }
});

module.exports = { router, JWT_SECRET };
