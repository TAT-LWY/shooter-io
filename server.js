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

const MAP_W = 8000;
const MAP_H = 6000;
const TICK_RATE = 30;
const PLAYER_SPEED = 8;
const BULLET_SPEED = 24;
const BULLET_LIFE = 30;
const PLAYER_RADIUS = 18;
const BULLET_RADIUS = 5;
const MAX_HP = 100;
const BULLET_DAMAGE = 20;
const RESPAWN_TIME = 3000;
const SHOOT_COOLDOWN = 150;
const STATE_SEND_RATE = 10;

const players = {};
const bullets = [];
const mobs = {};
let bulletId = 0;
let mobIdCounter = 0;
let serverTick = 0;
let stateTick = 0;

// ─── Spawn Point (star on map - top right area) ───
const SPAWN_POINT = { x: 6800, y: 900 };

// ─── Mob System - Tiered by depth ───
const MOB_TYPES = {
  // Zone 1 - Near spawn (easy)
  wolf: {
    name: '冰晶狼',
    hp: 60,
    speed: 4.4,
    radius: 18,
    color: '#a0b0c0',
    aggroRange: 250,
    damage: 6,
    attackCooldown: 1000,
    xpReward: 1,
    healReward: 10,
    respawnTime: 12000,
    zone: 1
  },
  // Zone 2 - Mid area
  wolf_alpha: {
    name: '寒冰头狼',
    hp: 120,
    speed: 5.6,
    radius: 22,
    color: '#7090b0',
    aggroRange: 350,
    damage: 12,
    attackCooldown: 700,
    xpReward: 2,
    healReward: 20,
    respawnTime: 18000,
    zone: 2
  },
  golem: {
    name: '冰霜巨人',
    hp: 200,
    speed: 2.4,
    radius: 28,
    color: '#5599cc',
    aggroRange: 400,
    damage: 15,
    attackCooldown: 2000,
    shootRange: 350,
    bulletSpeed: 16,
    xpReward: 3,
    healReward: 30,
    respawnTime: 25000,
    zone: 2
  },
  // Zone 3 - Deep area (hard)
  frost_wyrm: {
    name: '霜龙',
    hp: 350,
    speed: 3.6,
    radius: 35,
    color: '#3366aa',
    aggroRange: 500,
    damage: 25,
    attackCooldown: 1500,
    shootRange: 450,
    bulletSpeed: 20,
    xpReward: 5,
    healReward: 50,
    respawnTime: 40000,
    zone: 3
  },
  ice_elemental: {
    name: '冰元素',
    hp: 250,
    speed: 5.0,
    radius: 24,
    color: '#2255aa',
    aggroRange: 450,
    damage: 20,
    attackCooldown: 600,
    xpReward: 4,
    healReward: 40,
    respawnTime: 30000,
    zone: 3
  }
};

const MOB_SPAWNS = [
  // Zone 1 - Near spawn (top right) - easy wolves
  { type: 'wolf', x: 6200, y: 700 },
  { type: 'wolf', x: 6500, y: 1200 },
  { type: 'wolf', x: 5800, y: 900 },
  { type: 'wolf', x: 5500, y: 600 },
  { type: 'wolf', x: 6000, y: 1500 },
  // Zone 2 - Mid area (center corridor + upper branch)
  { type: 'wolf_alpha', x: 4500, y: 1200 },
  { type: 'wolf_alpha', x: 4000, y: 1600 },
  { type: 'wolf_alpha', x: 3500, y: 1000 },
  { type: 'golem', x: 4200, y: 800 },
  { type: 'golem', x: 3800, y: 1400 },
  { type: 'wolf', x: 4800, y: 1000 },
  { type: 'wolf', x: 3200, y: 1300 },
  // Upper branch (peninsula)
  { type: 'wolf_alpha', x: 2800, y: 1600 },
  { type: 'golem', x: 2400, y: 1800 },
  { type: 'wolf_alpha', x: 2000, y: 2000 },
  // Zone 3 - Deep area (bottom left) - hard mobs
  { type: 'frost_wyrm', x: 2500, y: 3500 },
  { type: 'frost_wyrm', x: 1800, y: 4000 },
  { type: 'ice_elemental', x: 3000, y: 3800 },
  { type: 'ice_elemental', x: 2200, y: 3200 },
  { type: 'ice_elemental', x: 3500, y: 4200 },
  { type: 'wolf_alpha', x: 3200, y: 3000 },
  { type: 'golem', x: 2800, y: 4300 },
  // Left branch - hard
  { type: 'frost_wyrm', x: 1200, y: 2800 },
  { type: 'ice_elemental', x: 1500, y: 2500 },
  { type: 'ice_elemental', x: 900, y: 3200 },
  { type: 'golem', x: 1800, y: 2200 },
];

function spawnMob(spawn) {
  const type = MOB_TYPES[spawn.type];
  const id = 'mob_' + (mobIdCounter++);
  mobs[id] = {
    id,
    type: spawn.type,
    x: spawn.x + (Math.random() - 0.5) * 60,
    y: spawn.y + (Math.random() - 0.5) * 60,
    spawnX: spawn.x,
    spawnY: spawn.y,
    hp: type.hp,
    maxHp: type.hp,
    radius: type.radius,
    speed: type.speed,
    color: type.color,
    name: type.name,
    alive: true,
    angle: Math.random() * Math.PI * 2,
    targetId: null,
    lastAttack: 0,
    wanderAngle: Math.random() * Math.PI * 2,
    wanderTimer: 0
  };
  return id;
}

// Spawn all mobs
for (const spawn of MOB_SPAWNS) {
  spawnMob(spawn);
}

function findClosestPlayer(mx, my, range) {
  let closest = null, minDist = range * range;
  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;
    const dx = p.x - mx, dy = p.y - my;
    const dist = dx * dx + dy * dy;
    if (dist < minDist) { minDist = dist; closest = id; }
  }
  return closest;
}

function updateMobs() {
  for (const id in mobs) {
    const m = mobs[id];
    if (!m.alive) continue;

    const type = MOB_TYPES[m.type];

    // Find target
    m.targetId = findClosestPlayer(m.x, m.y, type.aggroRange);

    if (m.targetId && players[m.targetId]) {
      const target = players[m.targetId];
      const dx = target.x - m.x, dy = target.y - m.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      m.angle = Math.atan2(dy, dx);

      if (type.shootRange && dist < type.shootRange) {
        // Ranged mob: shoot projectile
        const now = Date.now();
        if (now - m.lastAttack > type.attackCooldown) {
          m.lastAttack = now;
          const angle = m.angle;
          const bulletColor = type.zone === 3 ? '#4466ff' : '#88ccff';
          bullets.push({
            id: bulletId++,
            ownerId: id,
            x: m.x + Math.cos(angle) * (m.radius + 5),
            y: m.y + Math.sin(angle) * (m.radius + 5),
            vx: Math.cos(angle) * type.bulletSpeed,
            vy: Math.sin(angle) * type.bulletSpeed,
            life: 60,
            color: bulletColor,
            isMobBullet: true,
            damage: type.damage
          });
        }
        if (dist > type.shootRange * 0.6) {
          m.x += (dx / dist) * m.speed;
          m.y += (dy / dist) * m.speed;
        }
      } else if (!type.shootRange) {
        // Wolf: chase and melee
        if (dist > m.radius + PLAYER_RADIUS + 5) {
          m.x += (dx / dist) * m.speed;
          m.y += (dy / dist) * m.speed;
        } else {
          // Melee attack
          const now = Date.now();
          if (now - m.lastAttack > type.attackCooldown) {
            m.lastAttack = now;
            target.hp -= type.damage;
            io.emit('hits', [{
              targetId: m.targetId,
              shooterId: id,
              x: target.x, y: target.y,
              hp: target.hp,
              killed: target.hp <= 0
            }]);
            if (target.hp <= 0) {
              target.alive = false;
              target.deaths++;
              target.sessionDeaths++;
              target.killStreak = 0;
              setTimeout(() => {
                const sp = safeSpawnPos();
                target.hp = MAX_HP;
                target.alive = true;
                target.x = sp.x;
                target.y = sp.y;
              }, RESPAWN_TIME);
            }
          }
        }
      }
    } else {
      // Wander
      m.wanderTimer--;
      if (m.wanderTimer <= 0) {
        m.wanderAngle = Math.random() * Math.PI * 2;
        m.wanderTimer = 60 + Math.floor(Math.random() * 120);
      }
      m.x += Math.cos(m.wanderAngle) * m.speed * 0.3;
      m.y += Math.sin(m.wanderAngle) * m.speed * 0.3;

      // Don't wander too far from spawn
      const dsx = m.x - m.spawnX, dsy = m.y - m.spawnY;
      if (dsx * dsx + dsy * dsy > 200 * 200) {
        m.wanderAngle = Math.atan2(-dsy, -dsx);
      }
    }

    // Block collision
    if (collidesWithBlock(m.x, m.y, m.radius)) {
      m.x -= Math.cos(m.angle) * m.speed * 2;
      m.y -= Math.sin(m.angle) * m.speed * 2;
    }

    // Keep in map
    m.x = Math.max(m.radius, Math.min(MAP_W - m.radius, m.x));
    m.y = Math.max(m.radius, Math.min(MAP_H - m.radius, m.y));
  }
}

// Map obstacles - ice blocks (circles for irregular shapes)
const iceBlocks = [
  // Zone 1 - sparse, small
  { x: 6100, y: 600, r: 35 },
  { x: 5700, y: 1100, r: 40 },
  { x: 6400, y: 1400, r: 38 },
  // Zone 2 - medium density
  { x: 4600, y: 900, r: 50 },
  { x: 4100, y: 1100, r: 45 },
  { x: 3600, y: 800, r: 55 },
  { x: 4300, y: 1500, r: 42 },
  { x: 3200, y: 1500, r: 48 },
  { x: 5000, y: 1300, r: 40 },
  // Upper branch
  { x: 2600, y: 1700, r: 45 },
  { x: 2100, y: 1900, r: 50 },
  { x: 1700, y: 2100, r: 42 },
  // Zone 3 - dense, large
  { x: 2800, y: 3200, r: 60 },
  { x: 2200, y: 3600, r: 55 },
  { x: 3200, y: 3800, r: 50 },
  { x: 1600, y: 3400, r: 48 },
  { x: 3500, y: 4000, r: 55 },
  { x: 2500, y: 4200, r: 52 },
  { x: 1900, y: 4400, r: 45 },
  // Left branch
  { x: 1300, y: 2600, r: 50 },
  { x: 900, y: 3000, r: 55 },
  { x: 1100, y: 3400, r: 48 },
];

// Generate irregular polygon vertices for each ice block (for client rendering)
function generateIrregularShape(cx, cy, r, sides) {
  const points = [];
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2;
    const vary = 0.7 + Math.random() * 0.5; // 70%-120% of radius
    points.push({
      x: cx + Math.cos(angle) * r * vary,
      y: cy + Math.sin(angle) * r * vary
    });
  }
  return points;
}

// Pre-generate shapes (seeded by position for consistency)
for (const block of iceBlocks) {
  const sides = 6 + Math.floor((block.x * 7 + block.y * 13) % 4); // 6-9 sides
  // Use deterministic "random" based on position
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2;
    const seed = Math.sin(block.x * 12.9898 + block.y * 78.233 + i * 43.1234) * 43758.5453;
    const vary = 0.7 + (seed - Math.floor(seed)) * 0.5;
    pts.push({
      x: Math.cos(angle) * block.r * vary,
      y: Math.sin(angle) * block.r * vary
    });
  }
  block.shape = pts;
}

// ─── Custom cave-shaped map border ───
// Shape: Top-right spawn area → corridor left → upper-left branch → large bottom cavern
// Matches the hand-drawn map design
const MAP_BORDER_BASE = [
  // Top-right: spawn area (wide open)
  { x: 7200, y: 400 },
  { x: 7400, y: 600 },
  { x: 7500, y: 1000 },
  { x: 7300, y: 1400 },
  { x: 7000, y: 1700 },
  { x: 6600, y: 1900 },
  // Corridor going left
  { x: 6000, y: 1900 },
  { x: 5500, y: 1800 },
  { x: 5000, y: 1700 },
  { x: 4500, y: 1800 },
  { x: 4000, y: 1900 },
  // Branch point - path splits to upper-left and lower
  { x: 3500, y: 2100 },
  { x: 3200, y: 2400 },
  // Lower cavern (large, deep area)
  { x: 3600, y: 2800 },
  { x: 3800, y: 3300 },
  { x: 3900, y: 3800 },
  { x: 3800, y: 4300 },
  { x: 3500, y: 4700 },
  { x: 3000, y: 5000 },
  { x: 2500, y: 5100 },
  { x: 2000, y: 4900 },
  { x: 1600, y: 4500 },
  { x: 1400, y: 4000 },
  { x: 1300, y: 3500 },
  // Left branch (connects back up)
  { x: 1200, y: 3100 },
  { x: 900, y: 2800 },
  { x: 700, y: 2400 },
  { x: 700, y: 2000 },
  { x: 900, y: 1700 },
  // Upper-left peninsula
  { x: 1200, y: 1500 },
  { x: 1600, y: 1400 },
  { x: 2000, y: 1500 },
  { x: 2400, y: 1600 },
  { x: 2700, y: 1500 },
  // Back through upper corridor
  { x: 2900, y: 1300 },
  { x: 3100, y: 1100 },
  { x: 3400, y: 900 },
  { x: 3700, y: 700 },
  { x: 4000, y: 500 },
  { x: 4400, y: 400 },
  // Upper passage back to spawn
  { x: 4800, y: 350 },
  { x: 5200, y: 300 },
  { x: 5600, y: 350 },
  { x: 6000, y: 400 },
  { x: 6400, y: 350 },
  { x: 6800, y: 350 },
];

// Add noise to base points for organic feel
const MAP_BORDER_POINTS = MAP_BORDER_BASE.map((p, i) => {
  const seed1 = Math.sin(i * 45.678 + 12.345) * 43758.5453;
  const seed2 = Math.sin(i * 78.233 + 56.789) * 23421.6314;
  const wx = ((seed1 - Math.floor(seed1)) - 0.5) * 80;
  const wy = ((seed2 - Math.floor(seed2)) - 0.5) * 80;
  return { x: p.x + wx, y: p.y + wy };
});

function isInsideBorder(x, y) {
  // Ray casting algorithm
  let inside = false;
  const n = MAP_BORDER_POINTS.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = MAP_BORDER_POINTS[i].x, yi = MAP_BORDER_POINTS[i].y;
    const xj = MAP_BORDER_POINTS[j].x, yj = MAP_BORDER_POINTS[j].y;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Find closest point on border polygon edge and push player inside
function pushInsideBorder(px, py, radius) {
  const n = MAP_BORDER_POINTS.length;
  let closestDist = Infinity;
  let closestX = px, closestY = py;
  let edgeNx = 0, edgeNy = 0;

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = MAP_BORDER_POINTS[i].x, ay = MAP_BORDER_POINTS[i].y;
    const bx = MAP_BORDER_POINTS[j].x, by = MAP_BORDER_POINTS[j].y;
    // Project point onto segment
    const abx = bx - ax, aby = by - ay;
    const abLen2 = abx * abx + aby * aby;
    if (abLen2 === 0) continue;
    let t = ((px - ax) * abx + (py - ay) * aby) / abLen2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * abx, cy = ay + t * aby;
    const dx = px - cx, dy = py - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < closestDist) {
      closestDist = dist;
      closestX = cx;
      closestY = cy;
      // Inward normal (perpendicular to edge, pointing inward)
      // Use centroid of polygon as reference
      const cx = MAP_BORDER_POINTS.reduce((s, p) => s + p.x, 0) / MAP_BORDER_POINTS.length;
      const cy = MAP_BORDER_POINTS.reduce((s, p) => s + p.y, 0) / MAP_BORDER_POINTS.length;
      const mx = cx - (ax + bx) / 2;
      const my = cy - (ay + by) / 2;
      const nl = Math.sqrt(mx * mx + my * my) || 1;
      edgeNx = mx / nl;
      edgeNy = my / nl;
    }
  }

  // Place player on the border edge + radius inward
  return {
    x: closestX + edgeNx * (radius + 1),
    y: closestY + edgeNy * (radius + 1)
  };
}

// Ice lakes (circles where players slide)
const iceLakes = [
  // Zone 1 - small lakes near spawn
  { x: 6300, y: 800, r: 120 },
  { x: 5800, y: 1400, r: 100 },
  // Zone 2 - corridor
  { x: 4500, y: 1100, r: 150 },
  { x: 3800, y: 900, r: 130 },
  // Upper branch
  { x: 2200, y: 1700, r: 140 },
  // Zone 3 - large frozen lakes in deep cavern
  { x: 2800, y: 3500, r: 200 },
  { x: 2000, y: 4200, r: 180 },
  { x: 3400, y: 4400, r: 160 },
  // Left branch
  { x: 1000, y: 2600, r: 150 },
];

const ICE_FRICTION = 0.97; // Slide on ice
const ICE_SPEED_MULT = 1.5; // Faster on ice

function isOnIce(x, y) {
  for (const lake of iceLakes) {
    const dx = x - lake.x, dy = y - lake.y;
    if (dx * dx + dy * dy < lake.r * lake.r) return true;
  }
  return false;
}

function collidesWithBlock(x, y, radius) {
  for (const b of iceBlocks) {
    const dx = x - b.x, dy = y - b.y;
    if (dx * dx + dy * dy < (radius + b.r) * (radius + b.r)) return b;
  }
  return null;
}

function bulletHitsBlock(x, y) {
  for (const b of iceBlocks) {
    const dx = x - b.x, dy = y - b.y;
    if (dx * dx + dy * dy < b.r * b.r) return true;
  }
  return false;
}

// Safe spawn - near spawn point, inside border, not in blocks
function safeSpawnPos() {
  for (let tries = 0; tries < 50; tries++) {
    // Spawn within ~400px of spawn point
    const x = SPAWN_POINT.x + (Math.random() - 0.5) * 800;
    const y = SPAWN_POINT.y + (Math.random() - 0.5) * 600;
    if (isInsideBorder(x, y) && !collidesWithBlock(x, y, PLAYER_RADIUS)) return { x, y };
  }
  return { x: SPAWN_POINT.x, y: SPAWN_POINT.y };
}

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
  const spawnPos = safeSpawnPos();
  const player = {
    id: socket.id,
    x: spawnPos.x,
    y: spawnPos.y,
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
    tickRate: TICK_RATE,
    iceBlocks: iceBlocks.map(b => ({ x: b.x, y: b.y, r: b.r, shape: b.shape })),
    iceLakes,
    borderPoints: MAP_BORDER_POINTS,
    spawnPoint: SPAWN_POINT
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

  socket.on('ping_check', () => {
    socket.emit('pong_check');
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

  const onIce = isOnIce(p.x, p.y);
  const speed = onIce ? PLAYER_SPEED * ICE_SPEED_MULT : PLAYER_SPEED;

  if (!p.vx) p.vx = 0;
  if (!p.vy) p.vy = 0;

  if (dx || dy) {
    const len = Math.sqrt(dx * dx + dy * dy);
    if (onIce) {
      // On ice: add acceleration, momentum carries
      p.vx += (dx / len) * speed * 0.15;
      p.vy += (dy / len) * speed * 0.15;
    } else {
      // Normal ground: direct movement
      p.vx = (dx / len) * speed;
      p.vy = (dy / len) * speed;
    }
  }

  if (onIce) {
    p.vx *= ICE_FRICTION;
    p.vy *= ICE_FRICTION;
  } else {
    if (!dx && !dy) { p.vx = 0; p.vy = 0; }
  }

  // Clamp velocity
  const maxV = speed * 1.5;
  const v = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
  if (v > maxV) { p.vx = (p.vx / v) * maxV; p.vy = (p.vy / v) * maxV; }

  let newX = p.x + p.vx;
  let newY = p.y + p.vy;

  // Check collision with ice blocks (axis-separated)
  if (!collidesWithBlock(newX, p.y, PLAYER_RADIUS)) {
    p.x = newX;
  } else {
    p.vx = 0;
  }
  if (!collidesWithBlock(p.x, newY, PLAYER_RADIUS)) {
    p.y = newY;
  } else {
    p.vy = 0;
  }

  // Keep inside irregular border - pre-check to prevent jitter
  if (!isInsideBorder(p.x, p.y)) {
    // Already outside (shouldn't happen often), snap back
    const fix = pushInsideBorder(p.x, p.y, PLAYER_RADIUS);
    p.x = fix.x;
    p.y = fix.y;
    p.vx = 0;
    p.vy = 0;
  } else {
    // Check if NEXT frame's movement would push outside
    // Use a slightly inward check to create a buffer zone
    const checkX = p.x + p.vx;
    const checkY = p.y + p.vy;
    if (!isInsideBorder(checkX, checkY)) {
      // Find the closest border edge to slide along
      const n = MAP_BORDER_POINTS.length;
      let closestDist = Infinity, edgeDx = 0, edgeDy = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = MAP_BORDER_POINTS[i].x, ay = MAP_BORDER_POINTS[i].y;
        const bx = MAP_BORDER_POINTS[j].x, by = MAP_BORDER_POINTS[j].y;
        const abx = bx - ax, aby = by - ay;
        const abLen2 = abx * abx + aby * aby;
        if (abLen2 === 0) continue;
        let t = ((p.x - ax) * abx + (p.y - ay) * aby) / abLen2;
        t = Math.max(0, Math.min(1, t));
        const cx = ax + t * abx, cy = ay + t * aby;
        const ddx = p.x - cx, ddy = p.y - cy;
        const dist = ddx * ddx + ddy * ddy;
        if (dist < closestDist) {
          closestDist = dist;
          // Edge tangent direction (normalized)
          const eLen = Math.sqrt(abLen2);
          edgeDx = abx / eLen;
          edgeDy = aby / eLen;
        }
      }
      // Project velocity onto the edge tangent (slide along border)
      const dot = p.vx * edgeDx + p.vy * edgeDy;
      p.vx = edgeDx * dot * 0.7;
      p.vy = edgeDy * dot * 0.7;
    }
  }

  p.x = Math.max(PLAYER_RADIUS, Math.min(MAP_W - PLAYER_RADIUS, p.x));
  p.y = Math.max(PLAYER_RADIUS, Math.min(MAP_H - PLAYER_RADIUS, p.y));
}

function tick() {
  serverTick++;

  for (const id in players) {
    applyInput(players[id]);
  }

  // Update mobs AI
  updateMobs();

  const hitEvents = [];

  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx;
    b.y += b.vy;
    b.life--;
    if (b.life <= 0 || b.x < 0 || b.x > MAP_W || b.y < 0 || b.y > MAP_H || bulletHitsBlock(b.x, b.y)) {
      bullets.splice(i, 1);
      continue;
    }

    // Bullet vs Players
    let bulletRemoved = false;
    for (const id in players) {
      const p = players[id];
      if (!p.alive || id === b.ownerId) continue;
      const dx = p.x - b.x, dy = p.y - b.y;
      if (dx * dx + dy * dy < (PLAYER_RADIUS + BULLET_RADIUS) ** 2) {
        const dmg = b.isMobBullet ? (b.damage || 15) : BULLET_DAMAGE;
        p.hp -= dmg;
        hitEvents.push({
          targetId: id, shooterId: b.ownerId,
          x: b.x, y: b.y, hp: p.hp, killed: p.hp <= 0
        });
        bullets.splice(i, 1);
        bulletRemoved = true;
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
            const sp = safeSpawnPos();
            p.hp = MAX_HP;
            p.alive = true;
            p.x = sp.x;
            p.y = sp.y;
          }, RESPAWN_TIME);
        }
        break;
      }
    }
    if (bulletRemoved) continue;

    // Bullet vs Mobs (only player bullets can hurt mobs)
    if (!b.isMobBullet) {
      for (const mid in mobs) {
        const m = mobs[mid];
        if (!m.alive) continue;
        const dx = m.x - b.x, dy = m.y - b.y;
        if (dx * dx + dy * dy < (m.radius + BULLET_RADIUS) ** 2) {
          m.hp -= BULLET_DAMAGE;
          hitEvents.push({
            targetId: mid, shooterId: b.ownerId,
            x: b.x, y: b.y, hp: m.hp, killed: m.hp <= 0, isMob: true
          });
          bullets.splice(i, 1);
          if (m.hp <= 0) {
            m.alive = false;
            // Reward the killer
            const killer = players[b.ownerId];
            if (killer) {
              const type = MOB_TYPES[m.type];
              killer.kills += type.xpReward;
              killer.sessionKills += type.xpReward;
              killer.hp = Math.min(MAX_HP, killer.hp + type.healReward);
              // Notify killer of reward
              const killerSocket = io.sockets.sockets.get(b.ownerId);
              if (killerSocket) {
                killerSocket.emit('mobKillReward', {
                  heal: type.healReward,
                  xp: type.xpReward,
                  mobName: type.name,
                  x: m.x, y: m.y
                });
              }
            }
            // Respawn mob after delay
            const spawnData = MOB_SPAWNS.find(s =>
              Math.abs(s.x - m.spawnX) < 10 && Math.abs(s.y - m.spawnY) < 10
            );
            if (spawnData) {
              const respawnTime = MOB_TYPES[m.type].respawnTime;
              setTimeout(() => {
                delete mobs[mid];
                spawnMob(spawnData);
              }, respawnTime);
            }
          }
          break;
        }
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
      bullets: bullets.map(b => ({ id: b.id, x: Math.round(b.x), y: Math.round(b.y), color: b.color })),
      mobs: {}
    };
    for (const id in players) {
      const p = players[id];
      state.players[id] = {
        x: Math.round(p.x), y: Math.round(p.y), angle: +p.angle.toFixed(2), hp: p.hp,
        name: p.name, color: p.color, alive: p.alive,
        kills: p.kills, deaths: p.deaths, seq: p.seq
      };
    }
    for (const id in mobs) {
      const m = mobs[id];
      if (!m.alive) continue;
      const mobState = m.targetId && players[m.targetId] ? 'chase' : 'idle';
      const zone = MOB_TYPES[m.type] ? MOB_TYPES[m.type].zone : 1;
      state.mobs[id] = {
        x: Math.round(m.x), y: Math.round(m.y), angle: +m.angle.toFixed(2),
        hp: m.hp, maxHp: m.maxHp, radius: m.radius, color: m.color,
        name: m.name, type: m.type, state: mobState, zone
      };
    }
    io.emit('state', state);
  }
}

let tickTimeSum = 0, tickCount = 0;
setInterval(() => {
  const t0 = Date.now();
  tick();
  tickTimeSum += Date.now() - t0;
  tickCount++;
  if (tickCount >= 300) {
    console.log(`Avg tick: ${(tickTimeSum / tickCount).toFixed(1)}ms (${tickCount} ticks, ${Object.keys(players).length} players)`);
    tickTimeSum = 0; tickCount = 0;
  }
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
