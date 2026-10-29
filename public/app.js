'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const SUIT_ORDER = { S: 0, H: 1, D: 2, C: 3 };
  const RANK_ORDER = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const isRed = (s) => s === 'H' || s === 'D';

  // 브라우저별 고유 ID (재접속 시 자리 유지용)
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  let pid = store.get('onecard_pid');
  if (!pid) {
    pid = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
    store.set('onecard_pid', pid);
  }

  const params = new URLSearchParams(location.search);
  let roomCode = (params.get('room') || '').toUpperCase() || null;
  let myName = store.get('onecard_name') || '';
  let state = null;
  let joined = false;
  let selected = [];
  let feed = [];
  let lastLogSeq = 0;
  let lastGameNo = -1;
  let resultDismissed = false;
  let lastTurnSeq = null;
  let lastTurnPid = null;
  let lastShuffleSeq = null;
  let soundOn = store.get('onecard_sound') !== 'off';

  const socket = io();

  // ---------- 홈 ----------
  $('nameInput').value = myName;
  if (roomCode) {
    $('enterBtn').textContent = '입장하기';
    $('homeSub').textContent = `방 ${roomCode} 에 초대되었습니다`;
  }
  $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('enterBtn').click(); });
  $('enterBtn').onclick = () => {
    const name = $('nameInput').value.trim();
    if (!name) return toast('닉네임을 입력하세요', true);
    myName = name;
    store.set('onecard_name', name);
    if (roomCode) return join();
    socket.emit('create', (code) => {
      roomCode = code;
      history.replaceState(null, '', `?room=${code}`);
      join();
    });
  };

  function join() {
    socket.emit('join', { code: roomCode, name: myName, pid });
    joined = true;
  }

  socket.on('connect', () => { if (joined) join(); });
  socket.on('state', (s) => {
    s.deadline = s.timeLeft != null ? Date.now() + s.timeLeft : null;
    state = s;
    render();
  });
  socket.on('errorMsg', (m) => {
    toast(m, true);
    if (!state && m.includes('존재하지 않는 방')) {
      joined = false;
      roomCode = null;
      history.replaceState(null, '', location.pathname);
      $('enterBtn').textContent = '방 만들기';
      $('homeSub').textContent = '방이 없어졌어요. 새로 만들어 주세요';
    }
  });
  socket.on('kicked', (m) => { joined = false; toast(m, true); });
  socket.on('chat', ({ name, text }) => {
    feed.push({ chat: true, msg: `${name}: ${text}` });
    renderLog();
  });

  // ---------- 대기실 ----------
  const shareUrl = () => `${location.origin}${location.pathname}?room=${state.code}`;
  async function copyLink() {
    const url = shareUrl();
    try {
      if (navigator.share && /Mobi/i.test(navigator.userAgent)) await navigator.share({ title: '원카드 하자!', url });
      else { await navigator.clipboard.writeText(url); toast('링크를 복사했어요'); }
    } catch {
      $('shareLink').select();
      document.execCommand && document.execCommand('copy');
      toast('링크를 복사했어요');
    }
  }
  $('copyBtn').onclick = copyLink;
  $('copyBtn2').onclick = copyLink;
  $('startBtn').onclick = () => socket.emit('start');
  $('leaveBtn').onclick = () => {
    socket.emit('leave');
    joined = false;
    state = null;
    location.href = location.pathname;
  };
  $('turnTimeSel').onchange = (e) => socket.emit('settings', { turnTime: Number(e.target.value) });

  // ---------- 게임 ----------
  $('drawBtn').onclick = () => {
    if (state?.game?.over) { resultDismissed = false; return render(); }
    socket.emit('draw');
    selected = [];
  };
  $('deckPile').onclick = () => { if (isMyTurn()) $('drawBtn').click(); };
  $('playBtn').onclick = playSelected;
  $('oneCardBtn').onclick = () => socket.emit('onecard');
  $('againBtn').onclick = () => socket.emit('start');
  $('toLobbyBtn').onclick = () => { resultDismissed = true; render(); };
  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const t = $('chatInput').value.trim();
    if (t) socket.emit('chat', t);
    $('chatInput').value = '';
  };

  let pendingPlay = null;
  document.querySelectorAll('.suit-btn').forEach((b) => {
    b.onclick = () => {
      $('suitModal').classList.add('hidden');
      if (pendingPlay) socket.emit('play', { cardIds: pendingPlay, suit: b.dataset.suit });
      pendingPlay = null;
      selected = [];
    };
  });
  $('suitCancel').onclick = () => { $('suitModal').classList.add('hidden'); pendingPlay = null; };

  function isMyTurn() {
    return state?.game && !state.game.over && state.game.turnPid === pid;
  }

  function playSelected() {
    if (!isMyTurn()) return toast('내 차례가 아닙니다', true);
    if (!selected.length) return toast('낼 카드를 선택하세요 (카드를 두 번 누르면 바로 냄)', true);
    send(selected.slice());
  }

  function send(ids) {
    const hand = state.game.hand;
    const last = hand.find((c) => c.id === ids[ids.length - 1]);
    if (last && last.rank === '7') {
      pendingPlay = ids;
      $('suitModal').classList.remove('hidden');
      return;
    }
    socket.emit('play', { cardIds: ids });
    selected = [];
  }

  let lastTap = { id: null, t: 0 };
  function onCardTap(c) {
    const now = Date.now();
    // 더블탭 → 그 카드 한 장 바로 내기
    if (lastTap.id === c.id && now - lastTap.t < 350 && isMyTurn()) {
      lastTap = { id: null, t: 0 };
      selected = [];
      send([c.id]);
      return;
    }
    lastTap = { id: c.id, t: now };
    const i = selected.indexOf(c.id);
    if (i >= 0) selected.splice(i, 1);
    else selected.push(c.id);
    markSelection();
  }

  // DOM 을 다시 만들지 않고 선택 표시만 갱신 (더블탭이 끊기지 않도록)
  function markSelection() {
    for (const el of $('hand').querySelectorAll('.card')) {
      const id = Number(el.dataset.id);
      const si = selected.indexOf(id);
      el.classList.toggle('selected', si >= 0);
      el.querySelector('.sel-no')?.remove();
      if (si >= 0 && selected.length > 1) el.insertAdjacentHTML('beforeend', `<span class="sel-no">${si + 1}</span>`);
    }
  }

  // ---------- 렌더링 ----------
  const cardFile = (c) => (c.suit ? c.rank + c.suit : c.rank);
  const cardName = (c) => (c.rank === 'BJ' ? '흑백조커' : c.rank === 'CJ' ? '컬러조커' : SUIT_SYM[c.suit] + c.rank);

  function cardEl(c) {
    const el = document.createElement('div');
    el.className = 'card';
    const img = document.createElement('img');
    img.src = `cards/${cardFile(c)}.svg`;
    img.alt = cardName(c);
    img.draggable = false;
    el.appendChild(img);
    return el;
  }

  // 카드 이미지 미리 불러오기
  for (const s of 'SHDC') for (const r of RANK_ORDER) new Image().src = `cards/${r}${s}.svg`;
  for (const f of ['BJ', 'CJ', 'back']) new Image().src = `cards/${f}.svg`;
  let lastTopId = null;

  function sortHand(hand) {
    const key = (c) => (c.suit ? SUIT_ORDER[c.suit] * 20 + RANK_ORDER.indexOf(c.rank) : 100 + (c.rank === 'CJ' ? 1 : 0));
    return hand.slice().sort((a, b) => key(a) - key(b));
  }

  function show(id) {
    for (const s of ['home', 'lobby', 'game']) $(s).classList.toggle('hidden', s !== id);
  }

  function render() {
    if (!state) return show('home');
    const g = state.game;
    const inGame = g && g.players.some((p) => p.pid === pid);
    const amHost = state.hostPid === pid;

    if (state.gamesPlayed !== lastGameNo) {
      lastGameNo = state.gamesPlayed;
      lastLogSeq = 0;
      lastShuffleSeq = null;
      resultDismissed = false;
      selected = [];
      if (g) feed.push({ sep: true, msg: `GAME ${state.gamesPlayed}` });
    }

    if (!g || (!inGame && g.over)) {
      show('lobby');
      $('lobbyCode').textContent = state.code;
      $('shareLink').value = shareUrl();
      $('memberList').innerHTML = '';
      for (const m of state.members) {
        const li = document.createElement('li');
        const idx = state.members.indexOf(m) + 1;
        li.innerHTML = `<span class="no">${String(idx).padStart(2, '0')}</span><span class="nm"></span><span class="tag"></span>`;
        li.children[1].textContent = m.name + (m.pid === pid ? ' (나)' : '');
        li.children[2].textContent = [m.pid === state.hostPid ? '방장' : '', !m.connected ? '오프라인' : ''].filter(Boolean).join(' · ');
        if (m.pid === state.hostPid) li.children[2].classList.add('host');
        $('memberList').appendChild(li);
      }
      $('memberCount').textContent = `${state.members.length} / 6`;
      $('turnTimeSel').value = String(state.turnTime);
      $('turnTimeSel').disabled = !amHost;
      $('startBtn').classList.toggle('hidden', !amHost);
      const n = state.members.filter((m) => m.connected).length;
      $('lobbyHint').textContent = amHost
        ? (n < 2 ? '링크를 공유해 친구를 초대하세요 (2~6명)' : `${n}명 준비 완료${n > 6 ? ' · 앞의 6명만 참가' : ''}`)
        : '방장이 게임을 시작하기를 기다리고 있어요';
      $('startBtn').disabled = n < 2;
      return;
    }

    show('game');
    $('gameCode').textContent = state.code;
    $('dirInfo').textContent = g.direction === 1 ? '↻ 시계방향' : '↺ 반시계방향';

    // 상대 (내 다음 순서부터 좌석 순으로)
    const opp = $('opponents');
    opp.innerHTML = '';
    const myIdx = g.players.findIndex((p) => p.pid === pid);
    const order = g.players.map((_, i) => g.players[(i + Math.max(myIdx, 0) + 1) % g.players.length]).filter((p) => p.pid !== pid);
    for (const p of order) {
      const member = state.members.find((m) => m.pid === p.pid);
      const d = document.createElement('div');
      d.className = `opp ${p.pid === g.turnPid ? 'turn' : ''} ${p.out ? 'out' : ''} ${member && !member.connected ? 'offline' : ''}`;
      const n = document.createElement('div');
      n.className = 'name';
      n.textContent = p.name;
      d.appendChild(n);
      const cnt = document.createElement('div');
      cnt.className = 'count';
      cnt.textContent = p.result === 'bankrupt' ? '파산' : p.out ? `${p.rank}등` : `${p.count}장`;
      d.appendChild(cnt);
      const mini = document.createElement('div');
      mini.className = 'mini-cards';
      for (let i = 0; i < Math.min(p.count, 10); i++) mini.appendChild(document.createElement('span'));
      d.appendChild(mini);
      if (p.oneCard) d.insertAdjacentHTML('beforeend', '<span class="badge alert">ONE?</span>');
      else if (p.result === 'finish' || p.result === 'last') d.insertAdjacentHTML('beforeend', `<span class="badge done">${p.rank}등</span>`);
      else if (p.result === 'bankrupt') d.insertAdjacentHTML('beforeend', '<span class="badge bust">파산</span>');
      opp.appendChild(d);
    }

    // 테이블
    $('deckCount').textContent = g.deckCount;
    // 셔플 연출: 게임 시작 직후, 그리고 덱이 떨어져 다시 섞을 때
    if (g.shuffleSeq !== lastShuffleSeq) {
      if (lastShuffleSeq !== null || g.turnSeq <= 1) playShuffle();
      lastShuffleSeq = g.shuffleSeq;
    }
    const dp = $('discardPile');
    if (lastTopId !== g.top.id || !dp.firstChild) {
      const fresh = lastTopId !== null;
      lastTopId = g.top.id;
      dp.innerHTML = '';
      const el = cardEl(g.top);
      dp.appendChild(el);
      const lv = ATTACK_LEVEL[g.top.rank];
      if (fresh && lv && g.pendingAttack > 0) attackSlam(el, lv, g.pendingAttack);
    }
    const st = $('statusBox');
    st.innerHTML = '';
    const tag = (cls, k, v, vcls = '') => st.insertAdjacentHTML('beforeend', `<div class="tag ${cls}"><span class="k">${k}</span><span class="v ${vcls}">${v}</span></div>`);
    if (g.pendingAttack > 0) tag('attack', '공격 누적', `+${g.pendingAttack}`);
    if (g.declaredSuit) tag('suit-tag', '모양 변경', SUIT_SYM[g.declaredSuit], isRed(g.declaredSuit) ? 'red' : '');
    if (g.kChain) tag('k-tag', 'K · 같은 모양/K', SUIT_SYM[g.kChain.suit], isRed(g.kChain.suit) ? 'red' : '');
    tag('', '바닥', g.discardCount);

    // 차례
    const me = g.players.find((p) => p.pid === pid);
    const turnP = g.players.find((p) => p.pid === g.turnPid);
    const banner = $('turnBanner');
    const mine = isMyTurn();
    banner.className = `turn-banner ${mine ? 'mine' : ''}`;
    $('game').classList.toggle('my-turn', mine);
    // 내 차례에 공격이 들어와 있으면 화면 가장자리가 붉게 반짝임
    const underAttack = mine && g.pendingAttack > 0;
    $('game').classList.toggle('under-attack', underAttack);
    $('dangerGlow').classList.toggle('on', underAttack);
    if (g.over) banner.textContent = '게임 종료';
    else if (mine) {
      const sub = g.pendingAttack > 0 ? `막거나 ${g.pendingAttack}장 받기` : g.kChain ? 'K 효과로 한 장 더' : '카드를 내거나 받으세요';
      banner.innerHTML = `<span class="mine-pill"><span class="dot"></span>내 차례</span><span class="mine-sub">${sub}</span>`;
    } else banner.textContent = `${turnP ? turnP.name : ''} 님 차례`;
    if (mine && lastTurnSeq !== g.turnSeq) {
      selected = [];
      // 다른 사람 → 나로 넘어온 순간에만 알림 (K 로 이어서 내는 건 제외)
      if (lastTurnPid !== pid) turnCue(g.pendingAttack);
    }
    lastTurnSeq = g.turnSeq;
    lastTurnPid = g.turnPid;
    updateTitle(mine);

    // 버튼
    $('playBtn').disabled = !mine;
    $('drawBtn').disabled = !mine && !g.over;
    $('drawBtn').textContent = g.over ? '결과 보기' : g.pendingAttack > 0 ? `${g.pendingAttack}장 받기` : '카드 받기';
    const anyPending = g.players.some((p) => p.oneCard);
    $('oneCardBtn').classList.toggle('alert', anyPending);
    $('oneCardBtn').disabled = g.over || !me;

    $('meInfo').textContent = me
      ? me.out ? (me.result === 'bankrupt' ? '파산했습니다 · 관전 중' : `${me.rank}등으로 완주! 관전 중`) : `${myName || me.name} · ${me.count}장`
      : '관전 중 (다음 판부터 참가)';

    renderHand();
    renderLog();
    renderTimer();

    // 결과
    if (g.over && !resultDismissed) {
      const list = $('rankList');
      list.innerHTML = '';
      g.ranking.forEach((id) => {
        const p = g.players.find((x) => x.pid === id);
        const li = document.createElement('li');
        li.innerHTML = '<span class="nm"></span><span class="meta"></span>';
        li.children[0].textContent = p.name;
        li.children[1].textContent = [p.result === 'bankrupt' ? '파산' : '', id === pid ? '나' : ''].filter(Boolean).join(' · ');
        if (id === pid) li.children[1].classList.add('me');
        list.appendChild(li);
      });
      $('againBtn').classList.toggle('hidden', !amHost);
      $('resultHint').textContent = amHost ? '같은 멤버로 한 판 더 하면 1등이 선입니다' : '방장이 다음 판을 시작할 수 있어요 (1등이 선)';
      $('resultModal').classList.remove('hidden');
    } else {
      $('resultModal').classList.add('hidden');
    }
  }

  function renderHand() {
    const g = state?.game;
    const h = $('hand');
    h.innerHTML = '';
    if (!g || !g.hand) return;
    selected = selected.filter((id) => g.hand.some((c) => c.id === id));
    const mine = isMyTurn();
    const cards = sortHand(g.hand);
    // 손패가 많으면 겹쳐서 한 줄(필요하면 두 줄)에 배치
    const cardW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-w')) || 76;
    const avail = Math.max(h.clientWidth - 8, cardW * 2);
    const gap = 8;
    const stepFor = (n) => (n <= 1 ? cardW : Math.min(cardW + gap, (avail - cardW) / (n - 1)));
    const rows = stepFor(cards.length) < cardW * 0.42 ? 2 : 1;
    const perRow = Math.ceil(cards.length / rows);
    for (let r = 0; r < rows; r++) {
      const rowCards = cards.slice(r * perRow, (r + 1) * perRow);
      const step = stepFor(rowCards.length);
      const row = document.createElement('div');
      row.className = 'hand-row';
      rowCards.forEach((c, i) => {
        const el = cardEl(c);
        el.dataset.id = c.id;
        if (i > 0) el.style.marginLeft = `${step - cardW}px`;
        if (mine) el.classList.add(g.playable.includes(c.id) ? 'playable' : 'dim');
        el.onclick = () => onCardTap(c);
        row.appendChild(el);
      });
      h.appendChild(row);
    }
    markSelection();
  }

  function renderLog() {
    const g = state?.game;
    if (g) {
      const fresh = g.log.filter((l) => l.seq > lastLogSeq);
      for (const l of fresh) {
        feed.push({ chat: false, msg: l.msg });
        if (/🚨|💥|🏆|☝️|🎉|🔀|⏰/.test(l.msg)) toast(l.msg);
      }
      if (fresh.length) lastLogSeq = fresh[fresh.length - 1].seq;
    }
    if (feed.length > 200) feed = feed.slice(-200);
    const box = $('log');
    if (!box.offsetParent) return;
    box.innerHTML = '';
    for (const f of feed) {
      const d = document.createElement('div');
      if (f.chat) d.className = 'chat-line';
      if (f.sep) d.className = 'sep';
      d.textContent = f.msg;
      box.appendChild(d);
    }
    box.scrollTop = box.scrollHeight;
  }

  function renderTimer() {
    const t = $('timer');
    if (!state?.deadline || !state.game || state.game.over) { t.classList.add('hidden'); return; }
    const left = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
    t.classList.remove('hidden');
    t.textContent = `⏱ ${left}초`;
    t.classList.toggle('warn', left <= 5);
  }
  setInterval(renderTimer, 500);
  window.addEventListener('resize', () => { if (state?.game) renderHand(); });

  // ---------- 내 차례 알림 ----------
  let audioCtx = null;
  function chime() {
    if (!soundOn) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audioCtx.currentTime;
      [880, 1318.5].forEach((f, i) => {
        const o = audioCtx.createOscillator();
        const gn = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        const t = t0 + i * 0.12;
        gn.gain.setValueAtTime(0.0001, t);
        gn.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
        gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        o.connect(gn).connect(audioCtx.destination);
        o.start(t);
        o.stop(t + 0.4);
      });
    } catch {}
  }

  function riffleSound() {
    if (!soundOn) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = audioCtx;
      const noise = ctx.createBuffer(1, ctx.sampleRate * 0.05, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const t0 = ctx.currentTime + 0.02;
      // 촤르르: 짧은 노이즈 '톡' 소리를 점점 빠르게 여러 번
      let t = t0;
      for (let i = 0; i < 34; i++) {
        const src = ctx.createBufferSource();
        src.buffer = noise;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 2200 + Math.random() * 2200;
        bp.Q.value = 1.4;
        const gn = ctx.createGain();
        const peak = 0.22 + Math.random() * 0.12;
        gn.gain.setValueAtTime(0.0001, t);
        gn.gain.exponentialRampToValueAtTime(peak, t + 0.003);
        gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
        src.connect(bp).connect(gn).connect(ctx.destination);
        src.start(t);
        src.stop(t + 0.05);
        t += 0.026 - i * 0.0003 + Math.random() * 0.006;
      }
      // 마지막에 카드를 모으는 '착' 소리
      const end = ctx.createBufferSource();
      end.buffer = noise;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1400;
      const eg = ctx.createGain();
      const te = t + 0.05;
      eg.gain.setValueAtTime(0.0001, te);
      eg.gain.exponentialRampToValueAtTime(0.5, te + 0.005);
      eg.gain.exponentialRampToValueAtTime(0.0001, te + 0.08);
      end.connect(lp).connect(eg).connect(ctx.destination);
      end.start(te);
      end.stop(te + 0.1);
    } catch {}
  }

  function playShuffle() {
    const pile = $('deckPile');
    pile.querySelector('.shuffle-fx')?.remove();
    const fx = document.createElement('div');
    fx.className = 'shuffle-fx';
    for (let i = 0; i < 8; i++) {
      const c = document.createElement('div');
      c.className = `card back ${i % 2 ? 'r' : 'l'}`;
      c.style.animationDelay = `${Math.floor(i / 2) * 45}ms`;
      fx.appendChild(c);
    }
    pile.appendChild(fx);
    pile.classList.add('shuffling');
    riffleSound();
    setTimeout(() => { fx.remove(); pile.classList.remove('shuffling'); }, 1100);
  }

  // ---------- 공격 카드 연출 ----------
  const ATTACK_LEVEL = { '2': 1, A: 2, BJ: 3, CJ: 4 };

  function attackSlam(cardNode, lv, total) {
    cardNode.classList.add('slam', `lv${lv}`);
    const table = document.querySelector('.table');
    // 충격파 링
    for (let i = 0; i < (lv >= 3 ? 2 : 1); i++) {
      const ring = document.createElement('span');
      ring.className = `shock lv${lv}`;
      ring.style.animationDelay = `${180 + i * 120}ms`;
      $('discardPile').appendChild(ring);
      setTimeout(() => ring.remove(), 1200);
    }
    // +N 누적 숫자
    const burst = document.createElement('span');
    burst.className = `atk-burst lv${lv}`;
    burst.textContent = `+${total}`;
    $('discardPile').appendChild(burst);
    setTimeout(() => burst.remove(), 1300);
    // 테이블 흔들림 (조커는 화면 전체 섬광)
    table.classList.remove('shake', 'lv1', 'lv2', 'lv3', 'lv4');
    void table.offsetWidth;
    table.classList.add('shake', `lv${lv}`);
    setTimeout(() => table.classList.remove('shake', `lv${lv}`), 700);
    if (lv >= 3) {
      const f = $('impactFlash');
      f.className = `impact-flash lv${lv}`;
      void f.offsetWidth;
      f.classList.add('show');
    }
    if (navigator.vibrate) navigator.vibrate(lv >= 3 ? [40, 30, 120] : 60 + lv * 20);
    impactSound(lv);
  }

  function impactSound(lv) {
    if (!soundOn) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = audioCtx;
      const t = ctx.currentTime + 0.17; // 카드가 바닥에 닿는 순간에 맞춤
      // 묵직한 쿵: 주파수가 뚝 떨어지는 사인파
      const o = ctx.createOscillator();
      const g1 = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(150 + lv * 10, t);
      o.frequency.exponentialRampToValueAtTime(40, t + 0.35);
      g1.gain.setValueAtTime(0.0001, t);
      g1.gain.exponentialRampToValueAtTime(0.35 + lv * 0.08, t + 0.01);
      g1.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      o.connect(g1).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.5);
      // 탁: 짧은 노이즈
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.12, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
      const n = ctx.createBufferSource();
      n.buffer = buf;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900 + lv * 500;
      const g2 = ctx.createGain();
      g2.gain.value = 0.25 + lv * 0.08;
      n.connect(lp).connect(g2).connect(ctx.destination);
      n.start(t);
    } catch {}
  }

  function turnCue(attack) {
    chime();
    if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
    const f = $('turnFlash');
    f.classList.toggle('attack', attack > 0);
    f.firstElementChild.textContent = attack > 0 ? `공격 +${attack}!` : '내 차례';
    f.classList.remove('show');
    void f.offsetWidth; // 애니메이션 재시작
    f.classList.add('show');
  }

  const baseTitle = document.title;
  let titleTimer = null;
  function updateTitle(mine) {
    clearInterval(titleTimer);
    document.title = baseTitle;
    if (!mine) return;
    // 다른 탭을 보고 있어도 알 수 있게 탭 제목 깜빡임
    let on = false;
    titleTimer = setInterval(() => {
      on = !on;
      document.title = on ? '● 내 차례! · One Card' : baseTitle;
    }, 900);
  }

  function renderSoundBtn() {
    $('soundBtn').querySelector('.lbl').textContent = soundOn ? '소리 켬' : '소리 끔';
    $('soundBtn').classList.toggle('off', !soundOn);
  }
  $('soundBtn').onclick = () => {
    soundOn = !soundOn;
    store.set('onecard_sound', soundOn ? 'on' : 'off');
    renderSoundBtn();
    if (soundOn) chime();
  };
  renderSoundBtn();

  let toastTimer = null;
  function toast(msg, err) {
    const t = $('toast');
    t.textContent = msg;
    t.className = `toast ${err ? 'error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
  }

  render();
})();
