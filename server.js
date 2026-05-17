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
const mobs = {};
let bulletId = 0;
let mobIdCounter = 0;
let serverTick = 0;
let stateTick = 0;

// ─── Mob System ───
const MOB_TYPES = {
  wolf: {
    name: '冰晶狼',
    hp: 80,
    speed: 2.5,
    radius: 20,
    color: '#a0b0c0',
    aggroRange: 300,
    damage: 8,
    attackCooldown: 800, // melee attack ms
    xpReward: 1,
    healReward: 15,
    respawnTime: 15000
  },
  golem: {
    name: '冰霜巨人',
    hp: 200,
    speed: 1.2,
    radius: 28,
    color: '#5599cc',
    aggroRange: 400,
    damage: 15,
    attackCooldown: 2000, // shoots ice bolt
    shootRange: 350,
    bulletSpeed: 8,
    xpReward: 3,
    healReward: 35,
    respawnTime: 30000
  }
};

const MOB_SPAWNS = [
  // Wolves - scattered around map
  { type: 'wolf', x: 300, y: 600 },
  { type: 'wolf', x: 800, y: 400 },
  { type: 'wolf', x: 1800, y: 600 },
  { type: 'wolf', x: 2500, y: 500 },
  { type: 'wolf', x: 400, y: 1600 },
  { type: 'wolf', x: 1200, y: 2000 },
  { type: 'wolf', x: 2000, y: 1800 },
  { type: 'wolf', x: 2600, y: 2200 },
  { type: 'wolf', x: 1000, y: 1200 },
  { type: 'wolf', x: 2200, y: 1200 },
  // Golems - fewer, near center and key areas
  { type: 'golem', x: 750, y: 750 },
  { type: 'golem', x: 2250, y: 750 },
  { type: 'golem', x: 1500, y: 1500 },
  { type: 'golem', x: 750, y: 2250 },
  { type: 'golem', x: 2250, y: 2250 },
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

      if (m.type === 'golem' && type.shootRange && dist < type.shootRange) {
        // Golem: shoot ice bolt
        const now = Date.now();
        if (now - m.lastAttack > type.attackCooldown) {
          m.lastAttack = now;
          const angle = m.angle;
          bullets.push({
            id: bulletId++,
            ownerId: id, // mob id
            x: m.x + Math.cos(angle) * (m.radius + 5),
            y: m.y + Math.sin(angle) * (m.radius + 5),
            vx: Math.cos(angle) * type.bulletSpeed,
            vy: Math.sin(angle) * type.bulletSpeed,
            life: 50,
            color: '#88ccff',
            isMobBullet: true,
            damage: type.damage
          });
        }
        // Move closer if far
        if (dist > type.shootRange * 0.6) {
          m.x += (dx / dist) * m.speed;
          m.y += (dy / dist) * m.speed;
        }
      } else if (m.type === 'wolf') {
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
  { x: 440, y: 440, r: 45 },
  { x: 950, y: 330, r: 55 },
  { x: 1550, y: 550, r: 50 },
  { x: 2240, y: 440, r: 40 },
  { x: 2640, y: 840, r: 48 },
  { x: 540, y: 1260, r: 42 },
  { x: 1270, y: 1040, r: 55 },
  { x: 1840, y: 1340, r: 44 },
  { x: 2450, y: 1540, r: 50 },
  { x: 340, y: 2040, r: 46 },
  { x: 840, y: 1860, r: 38 },
  { x: 1550, y: 2240, r: 52 },
  { x: 2140, y: 2040, r: 43 },
  { x: 2540, y: 2440, r: 55 },
  { x: 1040, y: 2540, r: 40 },
  { x: 1440, y: 1440, r: 35 },
  { x: 1590, y: 1590, r: 32 },
  { x: 1380, y: 1640, r: 38 },
  { x: 1650, y: 1380, r: 36 },
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

// Generate irregular map border (wavy polygon)
const MAP_BORDER_POINTS = [];
const BORDER_SEGMENTS = 60;
const BORDER_MARGIN = 50;
for (let i = 0; i < BORDER_SEGMENTS; i++) {
  const angle = (i / BORDER_SEGMENTS) * Math.PI * 2;
  const baseR = Math.min(MAP_W, MAP_H) / 2 - BORDER_MARGIN;
  const seed = Math.sin(i * 45.678 + 12.345) * 43758.5453;
  const wave = (seed - Math.floor(seed)) * 80 - 40; // ±40 variation
  const r = baseR + wave;
  MAP_BORDER_POINTS.push({
    x: MAP_W / 2 + Math.cos(angle) * r,
    y: MAP_H / 2 + Math.sin(angle) * r
  });
}

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
      // Inward normal (toward center)
      const mx = MAP_W / 2 - (ax + bx) / 2;
      const my = MAP_H / 2 - (ay + by) / 2;
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
  { x: 700, y: 700, r: 150 },
  { x: 2300, y: 700, r: 120 },
  { x: 1500, y: 1500, r: 200 },
  { x: 600, y: 2300, r: 130 },
  { x: 2400, y: 2200, r: 160 },
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

// Safe spawn - ensure inside border and not in blocks
function safeSpawnPos() {
  for (let tries = 0; tries < 50; tries++) {
    const x = Math.random() * (MAP_W - 400) + 200;
    const y = Math.random() * (MAP_H - 400) + 200;
    if (isInsideBorder(x, y) && !collidesWithBlock(x, y, PLAYER_RADIUS)) return { x, y };
  }
  // Fallback: center of map
  return { x: MAP_W / 2, y: MAP_H / 2 };
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
    borderPoints: MAP_BORDER_POINTS
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

  const newX = p.x + p.vx;
  const newY = p.y + p.vy;

  // Check collision with ice blocks
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

  // Keep inside irregular border - smooth slide along edge
  if (!isInsideBorder(p.x, p.y)) {
    const fix = pushInsideBorder(p.x, p.y, PLAYER_RADIUS);
    p.x = fix.x;
    p.y = fix.y;
    // Dampen velocity instead of killing it (allows sliding)
    p.vx *= 0.3;
    p.vy *= 0.3;
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
      bullets: bullets.map(b => ({ id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, color: b.color })),
      mobs: {}
    };
    for (const id in players) {
      const p = players[id];
      state.players[id] = {
        x: p.x, y: p.y, angle: p.angle, hp: p.hp,
        name: p.name, color: p.color, alive: p.alive,
        kills: p.kills, deaths: p.deaths, seq: p.seq
      };
    }
    for (const id in mobs) {
      const m = mobs[id];
      if (!m.alive) continue;
      const mobState = m.targetId && players[m.targetId] ? 'chase' : 'idle';
      state.mobs[id] = {
        x: m.x, y: m.y, angle: m.angle, hp: m.hp, maxHp: m.maxHp,
        radius: m.radius, color: m.color, name: m.name, type: m.type,
        alive: m.alive, state: mobState, speed: m.speed
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
