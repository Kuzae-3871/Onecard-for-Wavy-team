'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Game } = require('./game');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 6;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server);

/** @type {Map<string, any>} */
const rooms = new Map();

function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  return String(name || '').trim().slice(0, 12) || '플레이어';
}

function roomView(room, pid) {
  return {
    code: room.code,
    hostPid: room.hostPid,
    me: pid,
    turnTime: room.turnTime,
    members: room.members.map((m) => ({ pid: m.pid, name: m.name, connected: m.connected })),
    lastWinner: room.lastWinner ? room.members.find((m) => m.pid === room.lastWinner)?.name || null : null,
    game: room.game ? room.game.view(pid) : null,
    timeLeft: room.deadline ? Math.max(0, room.deadline - Date.now()) : null,
    gamesPlayed: room.gamesPlayed,
  };
}

function broadcast(room) {
  syncTimer(room);
  for (const m of room.members) {
    if (m.socketId) io.to(m.socketId).emit('state', roomView(room, m.pid));
  }
}

// 차례가 바뀔 때마다 턴 타이머 재설정
function syncTimer(room) {
  const g = room.game;
  if (!g || g.over || !room.turnTime) {
    clearTimeout(room.timer);
    room.timer = null;
    room.deadline = null;
    room.timerSeq = null;
    return;
  }
  if (room.timerSeq === g.turnSeq) return;
  clearTimeout(room.timer);
  room.timerSeq = g.turnSeq;
  room.deadline = Date.now() + room.turnTime * 1000;
  room.timer = setTimeout(() => {
    if (room.game === g && g.turnSeq === room.timerSeq && !g.over) {
      g.timeout();
      afterAction(room);
    }
  }, room.turnTime * 1000);
}

function startGame(room) {
  const seats = room.members.filter((m) => m.connected).slice(0, MAX_PLAYERS);
  if (seats.length < 2) return '2명 이상이 있어야 시작할 수 있습니다.';
  // 같은 인원으로 계속하면 전 판 1등이 선, 아니면 랜덤
  const first = room.lastWinner && seats.some((s) => s.pid === room.lastWinner) ? room.lastWinner : null;
  room.game = new Game(seats, first);
  room.gamesPlayed++;
  return null;
}

io.on('connection', (socket) => {
  let room = null;
  let pid = null;

  const fail = (msg) => socket.emit('errorMsg', msg);

  socket.on('create', (cb) => {
    const code = newCode();
    rooms.set(code, {
      code,
      hostPid: null,
      members: [],
      game: null,
      lastWinner: null,
      turnTime: 30,
      timer: null,
      deadline: null,
      gamesPlayed: 0,
      emptySince: Date.now(),
    });
    if (typeof cb === 'function') cb(code);
  });

  socket.on('join', ({ code, name, pid: myPid } = {}) => {
    const r = rooms.get(String(code || '').toUpperCase());
    if (!r) return fail('존재하지 않는 방입니다. 링크를 확인하세요.');
    if (!myPid || typeof myPid !== 'string') return fail('잘못된 접속입니다.');
    let m = r.members.find((x) => x.pid === myPid);
    if (!m) {
      if (r.members.length >= 12) return fail('방이 가득 찼습니다.');
      m = { pid: myPid, name: cleanName(name), connected: true, socketId: socket.id };
      r.members.push(m);
    } else {
      if (m.socketId && m.socketId !== socket.id) io.to(m.socketId).emit('kicked', '다른 창에서 접속했습니다.');
      m.connected = true;
      m.socketId = socket.id;
      if (name) {
        m.name = cleanName(name);
        const gp = r.game && r.game.player(myPid);
        if (gp) gp.name = m.name;
      }
    }
    if (!r.hostPid || !r.members.some((x) => x.pid === r.hostPid && x.connected)) r.hostPid = myPid;
    r.emptySince = null;
    room = r;
    pid = myPid;
    socket.join(r.code);
    broadcast(r);
  });

  const guard = (fn) => (...args) => {
    if (!room || !pid) return fail('먼저 방에 입장하세요.');
    fn(...args);
  };

  socket.on('start', guard(() => {
    if (room.hostPid !== pid) return fail('방장만 시작할 수 있습니다.');
    if (room.game && !room.game.over) return fail('이미 게임 중입니다.');
    const err = startGame(room);
    if (err) return fail(err);
    broadcast(room);
  }));

  socket.on('settings', guard(({ turnTime } = {}) => {
    if (room.hostPid !== pid) return;
    if ([0, 15, 20, 30, 45, 60].includes(turnTime)) room.turnTime = turnTime;
    room.timerSeq = null;
    broadcast(room);
  }));

  socket.on('play', guard(({ cardIds, suit } = {}) => {
    if (!room.game) return;
    const err = room.game.play(pid, cardIds, suit);
    if (err) return fail(err);
    afterAction(room);
  }));

  socket.on('draw', guard(() => {
    if (!room.game) return;
    const err = room.game.draw(pid);
    if (err) return fail(err);
    afterAction(room);
  }));

  socket.on('onecard', guard(() => {
    if (!room.game) return;
    room.game.callOneCard(pid);
    afterAction(room);
  }));

  socket.on('chat', guard((text) => {
    const t = String(text || '').trim().slice(0, 100);
    if (!t) return;
    const m = room.members.find((x) => x.pid === pid);
    io.to(room.code).emit('chat', { name: m ? m.name : '?', text: t });
  }));

  socket.on('leave', guard(() => {
    leave(true);
  }));

  socket.on('disconnect', () => leave(false));

  function leave(explicit) {
    if (!room) return;
    const r = room;
    const m = r.members.find((x) => x.pid === pid);
    if (m && m.socketId === socket.id) {
      m.connected = false;
      m.socketId = null;
      const inGame = r.game && !r.game.over && r.game.player(pid);
      // 게임 중이 아니면 자리에서 제거 (게임 중이면 재접속 대비 자리 유지)
      if (!inGame || explicit) {
        if (!inGame) r.members = r.members.filter((x) => x.pid !== pid);
      }
      if (r.hostPid === pid) {
        const next = r.members.find((x) => x.connected);
        r.hostPid = next ? next.pid : null;
      }
      if (!r.members.some((x) => x.connected)) r.emptySince = Date.now();
      broadcast(r);
    }
    if (explicit) {
      socket.leave(r.code);
      room = null;
      pid = null;
    }
  }
});

function afterAction(room) {
  const g = room.game;
  if (g && g.over && room.lastGameDone !== g) {
    room.lastGameDone = g;
    room.lastWinner = g.ranking[0];
  }
  broadcast(room);
}

// 빈 방 정리 (30분)
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (r.emptySince && now - r.emptySince > 30 * 60 * 1000) {
      clearTimeout(r.timer);
      rooms.delete(code);
    }
  }
}, 60 * 1000);

server.listen(PORT, () => console.log(`원카드 서버 실행 중: http://localhost:${PORT}`));
