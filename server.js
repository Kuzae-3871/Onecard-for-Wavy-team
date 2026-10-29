'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Game } = require('./game');
const { chooseMove } = require('./bot');

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
    members: room.members.map((m) => ({ pid: m.pid, name: m.name, connected: m.connected, isBot: !!m.isBot })),
    lastWinner: room.lastWinner ? room.members.find((m) => m.pid === room.lastWinner)?.name || null : null,
    game: room.game ? room.game.view(pid) : null,
    timeLeft: room.deadline ? Math.max(0, room.deadline - Date.now()) : null,
    gamesPlayed: room.gamesPlayed,
  };
}

function broadcast(room) {
  syncTimer(room);
  scheduleBots(room);
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

// ---------- 컴퓨터 플레이어 ----------
const BOT_NAMES = ['COM 웨이브', 'COM 라임', 'COM 모듈', 'COM 큐브', 'COM 픽셀'];
const humansOnline = (room) => room.members.some((m) => !m.isBot && m.connected);
const isBotPid = (room, id) => room.members.some((m) => m.pid === id && m.isBot);

function scheduleBots(room) {
  const g = room.game;
  if (!g || g.over || !humansOnline(room)) return;
  // 1) 차례인 컴퓨터가 카드를 냄 (애니메이션을 볼 수 있게 약간 기다림)
  const cur = g.current;
  if (isBotPid(room, cur.pid) && room.botSeq !== g.turnSeq) {
    room.botSeq = g.turnSeq;
    clearTimeout(room.botTimer);
    const wait = 1000 + Math.random() * 800 + (g.pendingAttack ? 400 : 0);
    room.botTimer = setTimeout(() => {
      if (room.game !== g || g.over || g.turnSeq !== room.botSeq) return;
      const mv = chooseMove(g, cur.pid);
      const err = mv.type === 'play' ? g.play(cur.pid, mv.cardIds, mv.suit) : g.draw(cur.pid);
      if (err) g.draw(cur.pid);
      afterAction(room);
    }, wait);
  }
  // 2) 원카드: 컴퓨터는 자기 원카드를 외치고, 사람이 깜빡하면 잡아냄
  room.ocScheduled = room.ocScheduled || new Set();
  for (const id of [...room.ocScheduled]) if (!g.oneCard.has(id)) room.ocScheduled.delete(id);
  for (const id of g.oneCard) {
    if (room.ocScheduled.has(id)) continue;
    const bots = g.players.filter((p) => !p.out && isBotPid(room, p.pid) && p.pid !== id);
    const selfBot = isBotPid(room, id);
    if (!selfBot && !bots.length) continue;
    room.ocScheduled.add(id);
    const wait = selfBot ? 700 + Math.random() * 1600 : 2200 + Math.random() * 2500;
    setTimeout(() => {
      if (room.game !== g || g.over || !g.oneCard.has(id)) return;
      const caller = selfBot ? id : bots[Math.floor(Math.random() * bots.length)].pid;
      g.callOneCard(caller);
      afterAction(room);
    }, wait);
  }
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

  socket.on('addBot', guard(() => {
    if (room.hostPid !== pid) return fail('방장만 컴퓨터를 추가할 수 있습니다.');
    if (room.game && !room.game.over) return fail('게임 중에는 추가할 수 없습니다.');
    if (room.members.filter((m) => m.connected).length >= MAX_PLAYERS) return fail(`최대 ${MAX_PLAYERS}명까지 참가할 수 있습니다.`);
    const used = new Set(room.members.map((m) => m.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `COM ${room.members.length + 1}`;
    room.members.push({ pid: `bot-${Math.random().toString(36).slice(2, 10)}`, name, connected: true, isBot: true, socketId: null });
    broadcast(room);
  }));

  socket.on('removeBot', guard((botPid) => {
    if (room.hostPid !== pid) return;
    if (room.game && !room.game.over) return fail('게임 중에는 뺄 수 없습니다.');
    room.members = room.members.filter((m) => !(m.isBot && m.pid === botPid));
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

  socket.on('forfeit', guard(() => {
    const g = room.game;
    if (!g) return;
    const err = g.forfeit(pid);
    if (err) return fail(err);
    // 사람이 모두 빠지고 컴퓨터만 남으면 그 자리에서 순위를 정해 끝냄
    if (!g.over && !g.activePlayers().some((p) => !isBotPid(room, p.pid))) g.endByCount();
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
        const next = r.members.find((x) => x.connected && !x.isBot);
        r.hostPid = next ? next.pid : null;
      }
      if (!humansOnline(r)) r.emptySince = Date.now();
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
