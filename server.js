const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const WORLD = { width: 1600, height: 900 };
const PLAYER_RADIUS = 150;
const PLAYER_SPEED = 620;
const TICK_RATE = 30;
const DT = 1 / TICK_RATE;
const MAX_PLAYERS = 2;

const rooms = new Map();

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/game/:roomCode', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function sanitizeRoomCode(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
}

function createRoom(code) {
  const room = {
    code,
    players: new Map(),
    obstacles: [],
    started: false,
    ended: false,
    startAt: null,
    startedAt: null,
    endedAt: null,
    score: 0,
    lastSpawnAt: 0,
    obstacleSeq: 1,
    round: 0
  };
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  return rooms.get(code) || createRoom(code);
}

function publicPlayer(player) {
  return {
    id: player.id,
    number: player.number,
    x: player.x,
    y: player.y,
    color: player.color,
    ready: player.ready,
    connected: true
  };
}

function roomState(room) {
  return {
    roomCode: room.code,
    players: [...room.players.values()].map(publicPlayer),
    maxPlayers: MAX_PLAYERS,
    started: room.started,
    ended: room.ended,
    startAt: room.startAt,
    score: Math.floor(room.score),
    round: room.round
  };
}

function emitRoomState(room) {
  io.to(room.code).emit('room-state', roomState(room));
}

function resetRound(room) {
  room.obstacles = [];
  room.started = false;
  room.ended = false;
  room.startAt = null;
  room.startedAt = null;
  room.endedAt = null;
  room.score = 0;
  room.lastSpawnAt = 0;
  room.round += 1;

  const sorted = [...room.players.values()].sort((a, b) => a.number - b.number);
  sorted.forEach((player, index) => {
    player.ready = false;
    player.input.left = false;
    player.input.right = false;
    player.x = index === 0 ? 560 : 1040;
    player.y = 720;
  });
}

function maybeStart(room) {
  const players = [...room.players.values()];
  if (players.length !== 2 || room.started || room.startAt) return;
  if (!players.every((p) => p.ready)) return;

  room.obstacles = [];
  room.ended = false;
  room.score = 0;
  room.startedAt = null;
  room.lastSpawnAt = 0;
  room.startAt = Date.now() + 3000;

  io.to(room.code).emit('round-countdown', { startAt: room.startAt });
  emitRoomState(room);
}

function spawnObstacle(room, now) {
  const side = Math.random() < 0.5 ? 'left' : 'right';
  const width = 470 + Math.random() * 380;
  const height = 180 + Math.random() * 260;
  const y = -height / 2;
  const elapsed = room.startedAt ? (now - room.startedAt) / 1000 : 0;
  const speedBoost = Math.min(elapsed * 3.2, 190);
  const speed = 250 + Math.random() * 130 + speedBoost;

  room.obstacles.push({
    id: room.obstacleSeq++,
    side,
    y,
    width,
    height,
    speed
  });
}

function triangleVertices(obstacle) {
  const halfH = obstacle.height / 2;

  if (obstacle.side === 'left') {
    return [
      { x: 0, y: obstacle.y - halfH },
      { x: 0, y: obstacle.y + halfH },
      { x: obstacle.width, y: obstacle.y }
    ];
  }

  return [
    { x: WORLD.width, y: obstacle.y - halfH },
    { x: WORLD.width, y: obstacle.y + halfH },
    { x: WORLD.width - obstacle.width, y: obstacle.y }
  ];
}

function sign(p1, p2, p3) {
  return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
}

function pointInTriangle(point, a, b, c) {
  const d1 = sign(point, a, b);
  const d2 = sign(point, b, c);
  const d3 = sign(point, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function distanceSquaredPointToSegment(point, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = point.x - a.x;
  const apy = point.y - a.y;
  const abLenSq = abx * abx + aby * aby;
  const t = abLenSq === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLenSq));
  const closestX = a.x + abx * t;
  const closestY = a.y + aby * t;
  const dx = point.x - closestX;
  const dy = point.y - closestY;
  return dx * dx + dy * dy;
}

function circleHitsTriangle(player, obstacle) {
  const [a, b, c] = triangleVertices(obstacle);
  const center = { x: player.x, y: player.y };

  if (pointInTriangle(center, a, b, c)) return true;

  const radiusSq = PLAYER_RADIUS * PLAYER_RADIUS;
  return (
    distanceSquaredPointToSegment(center, a, b) <= radiusSq ||
    distanceSquaredPointToSegment(center, b, c) <= radiusSq ||
    distanceSquaredPointToSegment(center, c, a) <= radiusSq
  );
}

function endRound(room, hitPlayerId) {
  if (!room.started || room.ended) return;
  room.started = false;
  room.ended = true;
  room.endedAt = Date.now();
  room.startAt = null;

  for (const player of room.players.values()) {
    player.input.left = false;
    player.input.right = false;
    player.ready = false;
  }

  io.to(room.code).emit('round-ended', {
    score: Math.floor(room.score),
    hitPlayerId
  });
  emitRoomState(room);
}

function updateRoom(room, now) {
  if (room.startAt && !room.started && now >= room.startAt && room.players.size === 2) {
    room.started = true;
    room.ended = false;
    room.startedAt = now;
    room.startAt = null;
    room.lastSpawnAt = now - 900;
    io.to(room.code).emit('round-started', { startedAt: now });
  }

  if (!room.started) return;

  for (const player of room.players.values()) {
    let dir = 0;
    if (player.input.left) dir -= 1;
    if (player.input.right) dir += 1;
    player.x += dir * PLAYER_SPEED * DT;
    player.x = Math.max(PLAYER_RADIUS, Math.min(WORLD.width - PLAYER_RADIUS, player.x));
  }

  const elapsed = Math.max(0, (now - room.startedAt) / 1000);
  room.score = elapsed * 10;

  const spawnInterval = Math.max(520, 1500 - elapsed * 16);
  if (now - room.lastSpawnAt >= spawnInterval) {
    spawnObstacle(room, now);
    room.lastSpawnAt = now;
  }

  for (const obstacle of room.obstacles) {
    obstacle.y += obstacle.speed * DT;
  }

  room.obstacles = room.obstacles.filter((obstacle) =>
    obstacle.y - obstacle.height / 2 < WORLD.height + 120
  );

  for (const player of room.players.values()) {
    for (const obstacle of room.obstacles) {
      if (circleHitsTriangle(player, obstacle)) {
        endRound(room, player.id);
        return;
      }
    }
  }

  io.to(room.code).emit('snapshot', {
    serverTime: now,
    players: [...room.players.values()].map(publicPlayer),
    obstacles: room.obstacles,
    score: Math.floor(room.score),
    started: room.started
  });
}

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomCode, color }, ack = () => {}) => {
    const code = sanitizeRoomCode(roomCode);
    if (!code) {
      ack({ ok: false, error: 'Invalid room code.' });
      return;
    }

    const room = getRoom(code);
    const existingPlayer = room.players.get(socket.id);
    if (existingPlayer) {
      ack({
        ok: true,
        playerId: socket.id,
        playerNumber: existingPlayer.number,
        world: WORLD,
        playerRadius: PLAYER_RADIUS,
        state: roomState(room)
      });
      return;
    }

    if (room.players.size >= MAX_PLAYERS) {
      ack({ ok: false, error: 'This room already has two players.' });
      return;
    }

    const usedNumbers = new Set([...room.players.values()].map((p) => p.number));
    const number = usedNumbers.has(1) ? 2 : 1;
    const player = {
      id: socket.id,
      number,
      x: number === 1 ? 560 : 1040,
      y: 720,
      color: /^#[0-9A-F]{6}$/i.test(color || '') ? color : number === 1 ? '#52a7ff' : '#ff7a59',
      ready: false,
      input: { left: false, right: false }
    };

    room.players.set(socket.id, player);
    socket.data.roomCode = code;
    socket.join(code);

    ack({
      ok: true,
      playerId: socket.id,
      playerNumber: number,
      world: WORLD,
      playerRadius: PLAYER_RADIUS,
      state: roomState(room)
    });

    emitRoomState(room);
  });

  socket.on('set-color', ({ color }) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.id);
    if (!room || !player || !/^#[0-9A-F]{6}$/i.test(color || '')) return;
    player.color = color;
    emitRoomState(room);
  });

  socket.on('set-ready', ({ ready }) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.id);
    if (!room || !player || room.started) return;

    if (room.ended && ready) {
      const everyoneNotReady = [...room.players.values()].every((p) => !p.ready);
      if (everyoneNotReady) {
        room.ended = false;
        room.obstacles = [];
        room.score = 0;
      }
    }

    player.ready = Boolean(ready);
    emitRoomState(room);
    maybeStart(room);
  });

  socket.on('input', ({ left, right }) => {
    const room = rooms.get(socket.data.roomCode);
    const player = room?.players.get(socket.id);
    if (!room || !player) return;
    player.input.left = Boolean(left);
    player.input.right = Boolean(right);
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;

    room.players.delete(socket.id);
    room.started = false;
    room.startAt = null;
    room.obstacles = [];
    room.score = 0;

    for (const player of room.players.values()) {
      player.ready = false;
      player.input.left = false;
      player.input.right = false;
    }

    io.to(code).emit('peer-left');
    emitRoomState(room);

    if (room.players.size === 0) {
      setTimeout(() => {
        const current = rooms.get(code);
        if (current && current.players.size === 0) rooms.delete(code);
      }, 60_000);
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) updateRoom(room, now);
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Dodge Duo running on http://localhost:${PORT}`);
});
