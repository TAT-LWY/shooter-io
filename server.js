const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { pool, initDB } = require('./db');
const { router: authRouter, JWT_SECRET } = require('./routes/auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 2000,
  pingTimeout: 5000
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/auth', authRouter);

// Init database
initDB();

const MAP_W = 3000;
const MAP_H = 3000;
const TICK_RATE = 60;
const PLAYER_SPEED = 4;
const BULLET_SPEED = 12;
const BULLET_LIFE = 60;
const PLAYER_RADIUS = 18;
const BULLET_RADIUS = 5;
const MAX_HP = 100;
const BULLET_DAMAGE = 20;
const RESPAWN_TIME = 3000;
const SHOOT_COOLDOWN = 150;
const STATE_SEND_RATE = 20;

const players = {};
const bullets = [];
let bulletId = 0;
let serverTick = 0;
let stateTick = 0;

const COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
  '#1abc9c', '#e67e22', '#ec407a', '#26c6da', '#ff7043'
];

function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

// Save player stats to database
async function savePlayerStats(player) {
  if (!player.userId) return;
  try {
    const playTime = Math.floor((Date.now() - player.joinTime) / 1000);
    await pool.query(
      `UPDATE users SET
        kills = kills + $1,
        deaths = deaths + $2,
        games_played = games_played + 1,
        total_play_time = total_play_time + $3,
        best_kill_streak = GREATEST(best_kill_streak, $4)
      WHERE id = $5`,
      [player.sessionKills, player.sessionDeaths, playTime, player.bestStreakThisSession, player.userId]
    );
  } catch (err) {
    console.error('Failed to save stats:', err.message);
  }
}

io.on('connection', (socket) => {
  const player = {
    id: socket.id,
    x: Math.random() * (MAP_W - 200) + 100,
    y: Math.random() * (MAP_H - 200) + 100,
    angle: 0,
    hp: MAX_HP,
    kills: 0,
    deaths: 0,
    name: '',
    color: randomColor(),
    alive: true,
    input: { up: false, down: false, left: false, right: false },
    lastShot: 0,
    seq: 0,
    ping: 0,
    userId: null,
    username: null,
    sessionKills: 0,
    sessionDeaths: 0,
    killStreak: 0,
    bestStreakThisSession: 0,
    joinTime: Date.now()
  };
  players[socket.id] = player;

  socket.emit('init', {
    id: socket.id,
    mapW: MAP_W,
    mapH: MAP_H,
    playerSpeed: PLAYER_SPEED,
    playerRadius: PLAYER_RADIUS,
    bulletSpeed: BULLET_SPEED,
    bulletLife: BULLET_LIFE,
    bulletRadius: BULLET_RADIUS,
    bulletDamage: BULLET_DAMAGE,
    shootCooldown: SHOOT_COOLDOWN,
    tickRate: TICK_RATE
  });

  socket.on('auth', async (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const result = await pool.query('SELECT id, username FROM users WHERE id = $1', [decoded.id]);
      if (result.rows.length > 0) {
        const user = result.rows[0];
        player.userId = user.id;
        player.username = user.username;
        player.name = user.username;
        socket.emit('authSuccess', { username: user.username });
      }
    } catch (err) {
      socket.emit('authError', '登录已过期');
    }
  });

  socket.on('setName', (name) => {
    if (player.username) {
      player.name = player.username;
    } else {
      player.name = String(name).slice(0, 12) || 'Player';
    }
  });

  socket.on('input', (data) => {
    if (!player.alive) return;
    player.input = data.keys || player.input;
    player.angle = data.angle || 0;
    player.seq = data.seq || 0;
  });

  socket.on('shoot', (data) => {
    if (!player.alive) return;
    const now = Date.now();
    if (now - player.lastShot < SHOOT_COOLDOWN) return;
    player.lastShot = now;

    const angle = (data && data.angle != null) ? data.angle : player.angle;
    const bId = bulletId++;
    bullets.push({
      id: bId,
      ownerId: socket.id,
      x: player.x + Math.cos(angle) * (PLAYER_RADIUS + 8),
      y: player.y + Math.sin(angle) * (PLAYER_RADIUS + 8),
      vx: Math.cos(angle) * BULLET_SPEED,
      vy: Math.sin(angle) * BULLET_SPEED,
      life: BULLET_LIFE,
      color: player.color
    });

    socket.emit('shootConfirm', { clientId: data && data.clientId, serverId: bId });
  });

  socket.on('ping_check', (clientTime) => {
    socket.emit('pong_check', clientTime);
    player.ping = Date.now() - clientTime;
  });

  socket.on('disconnect', async () => {
    await savePlayerStats(player);
    delete players[socket.id];
  });
});

function applyInput(p) {
  if (!p.alive) return;
  const inp = p.input;
  let dx = 0, dy = 0;
  if (inp.up) dy -= 1;
  if (inp.down) dy += 1;
  if (inp.left) dx -= 1;
  if (inp.right) dx += 1;
  if (dx || dy) {
    const len = Math.sqrt(dx * dx + dy * dy);
    p.x += (dx / len) * PLAYER_SPEED;
    p.y += (dy / len) * PLAYER_SPEED;
  }
  p.x = Math.max(PLAYER_RADIUS, Math.min(MAP_W - PLAYER_RADIUS, p.x));
  p.y = Math.max(PLAYER_RADIUS, Math.min(MAP_H - PLAYER_RADIUS, p.y));
}

function tick() {
  serverTick++;

  for (const id in players) {
    applyInput(players[id]);
  }

  const hitEvents = [];

  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx;
    b.y += b.vy;
    b.life--;
    if (b.life <= 0 || b.x < 0 || b.x > MAP_W || b.y < 0 || b.y > MAP_H) {
      bullets.splice(i, 1);
      continue;
    }
    for (const id in players) {
      const p = players[id];
      if (!p.alive || id === b.ownerId) continue;
      const dx = p.x - b.x;
      const dy = p.y - b.y;
      if (dx * dx + dy * dy < (PLAYER_RADIUS + BULLET_RADIUS) ** 2) {
        p.hp -= BULLET_DAMAGE;
        hitEvents.push({
          targetId: id,
          shooterId: b.ownerId,
          x: b.x, y: b.y,
          hp: p.hp,
          killed: p.hp <= 0
        });
        bullets.splice(i, 1);
        if (p.hp <= 0) {
          p.alive = false;
          p.deaths++;
          p.sessionDeaths++;
          p.killStreak = 0;

          const shooter = players[b.ownerId];
          if (shooter) {
            shooter.kills++;
            shooter.sessionKills++;
            shooter.killStreak++;
            if (shooter.killStreak > shooter.bestStreakThisSession) {
              shooter.bestStreakThisSession = shooter.killStreak;
            }
          }

          setTimeout(() => {
            p.hp = MAX_HP;
            p.alive = true;
            p.x = Math.random() * (MAP_W - 200) + 100;
            p.y = Math.random() * (MAP_H - 200) + 100;
          }, RESPAWN_TIME);
        }
        break;
      }
    }
  }

  if (hitEvents.length > 0) {
    io.emit('hits', hitEvents);
  }

  const stateInterval = Math.round(TICK_RATE / STATE_SEND_RATE);
  if (serverTick % stateInterval === 0) {
    stateTick++;
    const state = {
      tick: stateTick,
      players: {},
      bullets: bullets.map(b => ({ id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, color: b.color }))
    };
    for (const id in players) {
      const p = players[id];
      state.players[id] = {
        x: p.x, y: p.y, angle: p.angle, hp: p.hp,
        name: p.name, color: p.color, alive: p.alive,
        kills: p.kills, deaths: p.deaths, seq: p.seq
      };
    }
    io.emit('state', state);
  }
}

setInterval(tick, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
