(() => {
  const WORLD = { width: 1600, height: 900 };
  const socket = io();
  const $ = (id) => document.getElementById(id);
  const home = $('home'), game = $('game'), createRoomBtn = $('createRoomBtn'), joinForm = $('joinForm');
  const roomInput = $('roomInput'), homeError = $('homeError'), roomCodeLabel = $('roomCodeLabel');
  const copyLinkBtn = $('copyLinkBtn'), connectionStatus = $('connectionStatus');
  const canvas = $('gameCanvas'), ctx = canvas.getContext('2d'), scoreEl = $('score');
  const lobbyOverlay = $('lobbyOverlay'), countdownOverlay = $('countdownOverlay');
  const countdownNumber = $('countdownNumber'), endOverlay = $('endOverlay'), finalScore = $('finalScore');
  const readyBtn = $('readyBtn'), playAgainBtn = $('playAgainBtn'), lobbyHint = $('lobbyHint');
  const leftBtn = $('leftBtn'), rightBtn = $('rightBtn'), swatches = $('swatches'), colorPicker = $('colorPicker');
  const playerOneSlot = $('playerOneSlot'), playerTwoSlot = $('playerTwoSlot');
  const presetColors = ['#52a7ff', '#ff7a59', '#ff4f9a', '#a96cff', '#35d07f', '#ffd54a'];

  const state = {
    roomCode: null, playerId: null, playerNumber: null,
    selectedColor: localStorage.getItem('dodge-duo-color') || presetColors[0],
    room: null, snapshot: { players: [], obstacles: [], score: 0 },
    ready: false, started: false, countdownStartAt: null, ended: false,
    input: { left: false, right: false }, predictedX: null, lastFrameAt: performance.now()
  };

  const getRoomCodeFromPath = () => {
    const match = location.pathname.match(/^\/game\/([A-Za-z0-9]+)/);
    return match ? match[1].toUpperCase() : null;
  };
  const normalizeRoomCode = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const navigateToRoom = (code) => { location.href = `/game/${normalizeRoomCode(code)}`; };
  function randomRoomCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 5; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    return code;
  }

  createRoomBtn.addEventListener('click', () => navigateToRoom(randomRoomCode()));
  joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = normalizeRoomCode(roomInput.value);
    if (!code) { homeError.textContent = 'Enter a room code.'; return; }
    navigateToRoom(code);
  });
  roomInput.addEventListener('input', () => {
    roomInput.value = normalizeRoomCode(roomInput.value);
    homeError.textContent = '';
  });

  function hexToRgbCss(hex) {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  }
  function chooseColor(color) {
    state.selectedColor = color;
    localStorage.setItem('dodge-duo-color', color);
    colorPicker.value = color;
    [...swatches.children].forEach((button) => {
      button.classList.toggle('selected', button.style.backgroundColor === hexToRgbCss(color));
    });
    socket.emit('set-color', { color });
  }
  function buildSwatches() {
    swatches.innerHTML = '';
    for (const color of presetColors) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch';
      button.style.background = color;
      button.setAttribute('aria-label', `Choose ${color}`);
      if (color.toLowerCase() === state.selectedColor.toLowerCase()) button.classList.add('selected');
      button.addEventListener('click', () => chooseColor(color));
      swatches.appendChild(button);
    }
    colorPicker.value = state.selectedColor;
  }
  colorPicker.addEventListener('input', (event) => chooseColor(event.target.value));

  function renderPlayerSlot(slot, player, number) {
    const dot = slot.querySelector('.slot-dot');
    const status = slot.querySelector('small');
    slot.classList.toggle('empty', !player);
    dot.style.background = player?.color || '#353b48';
    if (!player) { status.textContent = 'WAITING'; return; }
    const isYou = player.id === state.playerId;
    status.textContent = player.ready ? (isYou ? 'YOU · READY' : 'READY') : (isYou ? 'YOU' : 'CONNECTED');
    slot.querySelector('span:not(.slot-dot)').textContent = `PLAYER ${number}`;
  }
  function renderRoomState(room) {
    state.room = room;
    renderPlayerSlot(playerOneSlot, room.players.find((p) => p.number === 1), 1);
    renderPlayerSlot(playerTwoSlot, room.players.find((p) => p.number === 2), 2);
    const me = room.players.find((p) => p.id === state.playerId);
    state.ready = Boolean(me?.ready);
    readyBtn.classList.toggle('ready-active', state.ready);
    readyBtn.textContent = state.ready ? 'READY ✓' : 'READY';
    if (room.players.length < 2) lobbyHint.textContent = 'Share the room link with one other player.';
    else if (!room.players.every((p) => p.ready)) lobbyHint.textContent = 'Both players press READY.';
    else lobbyHint.textContent = 'Starting…';
    if (!room.started && !state.ended && !state.countdownStartAt) lobbyOverlay.classList.remove('hidden');
  }

  readyBtn.addEventListener('click', () => {
    if (!state.room || state.room.players.length < 1) return;
    socket.emit('set-ready', { ready: !state.ready });
  });
  playAgainBtn.addEventListener('click', () => {
    endOverlay.classList.add('hidden');
    lobbyOverlay.classList.remove('hidden');
    state.ended = false;
    socket.emit('set-ready', { ready: true });
  });
  copyLinkBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      copyLinkBtn.textContent = '✓';
      setTimeout(() => { copyLinkBtn.textContent = '⧉'; }, 1100);
    } catch { window.prompt('Copy this link:', location.href); }
  });

  function sendInput() { socket.emit('input', { ...state.input }); }
  function setDirection(key, pressed) {
    if (state.input[key] === pressed) return;
    state.input[key] = pressed;
    (key === 'left' ? leftBtn : rightBtn).classList.toggle('pressed', pressed);
    sendInput();
  }
  window.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); setDirection('left', true); }
    if (event.key === 'ArrowRight') { event.preventDefault(); setDirection('right', true); }
  }, { passive: false });
  window.addEventListener('keyup', (event) => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); setDirection('left', false); }
    if (event.key === 'ArrowRight') { event.preventDefault(); setDirection('right', false); }
  }, { passive: false });
  window.addEventListener('blur', () => {
    state.input.left = false; state.input.right = false;
    leftBtn.classList.remove('pressed'); rightBtn.classList.remove('pressed'); sendInput();
  });

  function bindHoldButton(button, key) {
    const press = (event) => { event.preventDefault(); button.setPointerCapture?.(event.pointerId); setDirection(key, true); };
    const release = (event) => { event.preventDefault(); setDirection(key, false); };
    button.addEventListener('pointerdown', press);
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('pointerleave', (event) => { if (event.buttons === 0) release(event); });
  }
  bindHoldButton(leftBtn, 'left');
  bindHoldButton(rightBtn, 'right');

  socket.on('connect', () => { connectionStatus.textContent = 'CONNECTED'; if (state.roomCode) joinRoom(); });
  socket.on('disconnect', () => { connectionStatus.textContent = 'RECONNECTING'; });
  socket.on('room-state', renderRoomState);
  socket.on('round-countdown', ({ startAt }) => {
    state.countdownStartAt = startAt; state.started = false; state.ended = false;
    lobbyOverlay.classList.add('hidden'); endOverlay.classList.add('hidden'); countdownOverlay.classList.remove('hidden');
  });
  socket.on('round-started', () => {
    state.started = true; state.ended = false; state.countdownStartAt = null;
    countdownOverlay.classList.add('hidden'); lobbyOverlay.classList.add('hidden'); endOverlay.classList.add('hidden');
    state.predictedX = null;
  });
  socket.on('snapshot', (snapshot) => {
    state.snapshot = snapshot; scoreEl.textContent = snapshot.score;
    const me = snapshot.players.find((p) => p.id === state.playerId);
    if (me && state.predictedX == null) state.predictedX = me.x;
  });
  socket.on('round-ended', ({ score }) => {
    state.started = false; state.ended = true; state.countdownStartAt = null;
    state.input.left = false; state.input.right = false;
    leftBtn.classList.remove('pressed'); rightBtn.classList.remove('pressed');
    scoreEl.textContent = score; finalScore.textContent = score;
    countdownOverlay.classList.add('hidden'); lobbyOverlay.classList.add('hidden'); endOverlay.classList.remove('hidden');
  });
  socket.on('peer-left', () => {
    state.started = false; state.ended = false; state.countdownStartAt = null;
    countdownOverlay.classList.add('hidden'); endOverlay.classList.add('hidden'); lobbyOverlay.classList.remove('hidden');
    lobbyHint.textContent = 'The other player left. Share the room link again.';
  });

  function joinRoom() {
    socket.emit('join-room', { roomCode: state.roomCode, color: state.selectedColor }, (response) => {
      if (!response?.ok) { alert(response?.error || 'Could not join room.'); location.href = '/'; return; }
      state.playerId = response.playerId; state.playerNumber = response.playerNumber;
      roomCodeLabel.textContent = state.roomCode; renderRoomState(response.state);
    });
  }

  function drawTriangle(obstacle) {
    const halfH = obstacle.height / 2;
    const points = obstacle.side === 'left'
      ? [[0, obstacle.y - halfH], [0, obstacle.y + halfH], [obstacle.width, obstacle.y]]
      : [[WORLD.width, obstacle.y - halfH], [WORLD.width, obstacle.y + halfH], [WORLD.width - obstacle.width, obstacle.y]];
    ctx.beginPath(); ctx.moveTo(points[0][0], points[0][1]); ctx.lineTo(points[1][0], points[1][1]);
    ctx.lineTo(points[2][0], points[2][1]); ctx.closePath(); ctx.fillStyle = '#f5f7fb'; ctx.fill();
  }
  function drawPlayer(player, xOverride = null) {
    const x = xOverride ?? player.x;
    ctx.beginPath(); ctx.arc(x, player.y, 150, 0, Math.PI * 2); ctx.fillStyle = player.color; ctx.fill();
    if (player.id === state.playerId) {
      ctx.beginPath(); ctx.arc(x, player.y, 161, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.lineWidth = 7; ctx.stroke();
    }
  }
  function drawCenterGuide() {
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.045)'; ctx.lineWidth = 2; ctx.setLineDash([12, 18]);
    ctx.beginPath(); ctx.moveTo(WORLD.width / 2, 0); ctx.lineTo(WORLD.width / 2, WORLD.height); ctx.stroke(); ctx.restore();
  }
  function drawScene(now) {
    const delta = Math.min(0.05, (now - state.lastFrameAt) / 1000);
    state.lastFrameAt = now;
    ctx.clearRect(0, 0, WORLD.width, WORLD.height);
    ctx.fillStyle = '#0b0c10'; ctx.fillRect(0, 0, WORLD.width, WORLD.height); drawCenterGuide();
    for (const obstacle of state.snapshot.obstacles || []) drawTriangle(obstacle);
    const players = state.snapshot.players?.length ? state.snapshot.players : state.room?.players || [];
    for (const player of players) {
      let xOverride = null;
      if (player.id === state.playerId && state.started) {
        if (state.predictedX == null) state.predictedX = player.x;
        let dir = 0; if (state.input.left) dir -= 1; if (state.input.right) dir += 1;
        state.predictedX += dir * 620 * delta;
        state.predictedX = Math.max(150, Math.min(WORLD.width - 150, state.predictedX));
        state.predictedX += (player.x - state.predictedX) * Math.min(1, delta * 7);
        xOverride = state.predictedX;
      }
      drawPlayer(player, xOverride);
    }
    if (state.countdownStartAt) {
      const ms = state.countdownStartAt - Date.now();
      countdownNumber.textContent = Math.max(1, Math.ceil(ms / 1000));
    }
    requestAnimationFrame(drawScene);
  }

  function init() {
    buildSwatches();
    state.roomCode = getRoomCodeFromPath();
    if (!state.roomCode) { home.classList.remove('hidden'); game.classList.add('hidden'); return; }
    home.classList.add('hidden'); game.classList.remove('hidden'); roomCodeLabel.textContent = state.roomCode;
    requestAnimationFrame(drawScene);
    if (socket.connected) joinRoom();
  }
  init();
})();
