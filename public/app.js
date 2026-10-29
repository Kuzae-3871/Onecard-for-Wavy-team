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
  let overSeenAt = null;
  const WIN_DELAY = 2700; // Winner 연출이 끝난 뒤 결과창
  let lastTurnSeq = null;
  let lastTurnPid = null;
  let lastShuffleSeq = null;
  let lastEventSeq = null;
  let pendingLand = null;
  let soundOn = store.get('onecard_sound') !== 'off';

  const socket = io();

  // ---------- 홈 ----------
  $('nameInput').value = myName;
  if (roomCode) {
    $('enterBtn').textContent = '입장하기';
    $('homeSub').textContent = `방 ${roomCode} 에 초대되었습니다`;
  }
  $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('enterBtn').click(); });
  let pendingBots = 0;
  function enter(bots) {
    const name = $('nameInput').value.trim();
    if (!name) return toast('닉네임을 입력하세요', true);
    myName = name;
    store.set('onecard_name', name);
    if (roomCode && !bots) return join();
    pendingBots = bots;
    socket.emit('create', (code) => {
      roomCode = code;
      history.replaceState(null, '', `?room=${code}`);
      join();
    });
  }
  $('enterBtn').onclick = () => enter(0);
  // 혼자 하기: 방을 만들고 컴퓨터 2명을 바로 추가
  $('soloBtn').onclick = () => enter(2);

  function join() {
    socket.emit('join', { code: roomCode, name: myName, pid });
    joined = true;
  }

  socket.on('connect', () => { if (joined) join(); });
  socket.on('state', (s) => {
    s.deadline = s.timeLeft != null ? Date.now() + s.timeLeft : null;
    const snap = snapshotRects(); // 다시 그리기 전 카드 위치 (날아가는 애니메이션 출발점)
    state = s;
    render();
    runEvents(snap);
  });
  socket.on('errorMsg', (m) => {
    if (pending) cancelPending(m); // 낙관적으로 낸 카드를 되돌림
    else toast(m, true);
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
  $('addBotBtn').onclick = () => socket.emit('addBot');
  $('forfeitBtn').onclick = () => $('forfeitModal').classList.remove('hidden');
  $('forfeitCancel').onclick = () => $('forfeitModal').classList.add('hidden');
  $('forfeitConfirm').onclick = () => {
    $('forfeitModal').classList.add('hidden');
    socket.emit('forfeit');
  };
  function goHome() {
    socket.emit('leave');
    joined = false;
    state = null;
    location.href = location.pathname;
  }
  $('leaveBtn').onclick = goHome;
  $('homeBtn').onclick = goHome;
  $('turnTimeSel').onchange = (e) => socket.emit('settings', { turnTime: Number(e.target.value) });

  // ---------- 게임 ----------
  $('drawBtn').onclick = () => {
    if (state?.game?.over) { resultDismissed = false; return render(); }
    socket.emit('draw');
    selected = [];
  };
  $('deckPile').onclick = () => { if (isMyTurn()) $('drawBtn').click(); };
  $('oneCardBtn').onclick = () => socket.emit('onecard');
  $('againBtn').onclick = () => socket.emit('start');
  $('toLobbyBtn').onclick = () => { resultDismissed = true; render(); };
  $('chatForm').onsubmit = (e) => {
    e.preventDefault();
    const t = $('chatInput').value.trim();
    if (t) socket.emit('chat', t);
    $('chatInput').value = '';
  };

  function isMyTurn() {
    return state?.game && !state.game.over && state.game.turnPid === pid;
  }

  // ---------- 카드 내기: 탭 한 번 ----------
  // 낼 수 있는 카드는 탭하면 바로 냄. 서버 응답을 기다리지 않고 카드부터 날려 보내고(낙관적 연출),
  // 서버가 거절하면 손패로 되돌림.
  let pending = null; // { ids, timer }
  let opt = null; // 낙관적 비행 상태 { flyers, done, resolved, land }
  let pop = null;

  function closePop() {
    if (pop) { pop.remove(); pop = null; }
  }
  document.addEventListener('pointerdown', (e) => { if (pop && !pop.contains(e.target)) closePop(); }, true);

  function whyNot() {
    const g = state.game;
    if (!isMyTurn()) return '내 차례가 아니에요';
    const top = g.top;
    if (g.kChain) return `K 다음엔 ${SUIT_SYM[g.kChain.suit]} 또는 K만 낼 수 있어요`;
    if (g.pendingAttack > 0) {
      if (top.rank === 'CJ') return '컬러조커는 막을 수 없어요 · 받기';
      if (top.rank === 'BJ') return '흑백조커는 ♠A·컬러조커로만 막아요';
      if (top.rank === 'A') return 'A 공격은 A·조커로만 막아요';
      return `2 공격은 2·${SUIT_SYM[top.suit]}A·조커로만 막아요`;
    }
    if (g.declaredSuit) return `모양이 ${SUIT_SYM[g.declaredSuit]}(으)로 바뀌었어요`;
    return '모양이나 숫자가 맞지 않아요';
  }

  function tip(el, msg) {
    const r = el.getBoundingClientRect();
    const b = document.createElement('div');
    b.className = 'tip';
    b.textContent = msg;
    b.style.left = `${Math.min(Math.max(r.left + r.width / 2, 90), innerWidth - 90)}px`;
    b.style.top = `${r.top - 8}px`;
    document.body.appendChild(b);
    setTimeout(() => b.remove(), 1500);
  }

  function nope(el, msg) {
    el.classList.remove('nope');
    void el.offsetWidth;
    el.classList.add('nope');
    tip(el, msg);
    if (navigator.vibrate) navigator.vibrate(30);
  }

  // 카드 바로 위에 뜨는 작은 선택지 (여러 장 / 7 모양)
  function showPop(el, items, kind) {
    closePop();
    const r = el.getBoundingClientRect();
    pop = document.createElement('div');
    pop.className = `quick-pop ${kind || ''}`;
    for (const it of items) {
      const b = document.createElement('button');
      b.className = `qp-btn ${it.primary ? 'primary' : ''} ${it.red ? 'red' : ''}`;
      b.textContent = it.label;
      b.onclick = (e) => { e.stopPropagation(); it.act(); };
      pop.appendChild(b);
    }
    document.body.appendChild(pop);
    const w = pop.offsetWidth;
    pop.style.left = `${Math.min(Math.max(r.left + r.width / 2 - w / 2, 8), innerWidth - w - 8)}px`;
    pop.style.top = `${Math.max(r.top - pop.offsetHeight - 10, 8)}px`;
  }

  function onCardTap(c, el) {
    const g = state?.game;
    if (!g || g.over || pending) return;
    closePop();
    if (!isMyTurn() || !g.playable.includes(c.id)) return nope(el, whyNot());
    // 바닥과 같은 숫자를 여러 장 갖고 있으면 1장/모두 선택
    const top = g.top;
    const same = top.suit && c.rank === top.rank ? g.hand.filter((x) => x.rank === top.rank && g.playable.includes(x.id)) : [];
    if (same.length > 1) {
      const all = [...same.filter((x) => x.id !== c.id).map((x) => x.id), c.id]; // 누른 카드가 맨 위
      return showPop(el, [
        { label: '1장만', act: () => choose([c.id], el) },
        { label: `${same.length}장 모두`, primary: true, act: () => choose(all, el) },
      ]);
    }
    choose([c.id], el);
  }

  function choose(ids, el) {
    const last = state.game.hand.find((x) => x.id === ids[ids.length - 1]);
    if (last.rank === '7') {
      return showPop(el, ['S', 'H', 'D', 'C'].map((s) => ({ label: SUIT_SYM[s], red: isRed(s), act: () => commit(ids, s) })), 'suits');
    }
    commit(ids);
  }

  function commit(ids, suit) {
    closePop();
    const g = state.game;
    socket.emit('play', { cardIds: ids, suit });
    const pile = rectOf($('discardPile').querySelector('.card'));
    opt = { flyers: [], done: false, resolved: false, land: null };
    ids.forEach((id, i) => {
      const el = handEls.get(id);
      const c = g.hand.find((x) => x.id === id);
      if (!el || !c) return;
      const from = rectOf(el);
      el.classList.add('gone');
      const isLast = i === ids.length - 1;
      const f = fly({
        face: c, from, to: pile, delay: i * 110, keep: true,
        mode: isLast && ATTACK_LEVEL[c.rank] ? 'toSlam' : 'play',
        onStart: () => swish(0.5),
        onDone: isLast ? () => { if (opt) { opt.done = true; finishOpt(); } } : null,
      });
      if (f) opt.flyers.push(f);
    });
    pending = { ids, timer: setTimeout(() => cancelPending(), 4000) };
  }

  function finishOpt() {
    if (!opt || !opt.done || !opt.resolved) return;
    const o = opt;
    opt = null;
    doLand(o.land);
    o.flyers.forEach((f) => f.remove());
  }

  function cancelPending(msg) {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending = null;
    if (opt) { opt.flyers.forEach((f) => f.remove()); opt = null; }
    renderHand();
    if (msg) toast(msg, true);
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
  const cardSrc = (c) => `cards/${cardFile(c)}.webp`;
  const cardName = (c) => (c.rank === 'BJ' ? '흑백조커' : c.rank === 'CJ' ? '컬러조커' : SUIT_SYM[c.suit] + c.rank);

  function cardEl(c) {
    const el = document.createElement('div');
    el.className = 'card';
    const img = document.createElement('img');
    img.src = cardSrc(c);
    img.decoding = 'sync';
    img.alt = cardName(c);
    img.draggable = false;
    el.appendChild(img);
    return el;
  }

  // 카드 이미지 미리 불러오기
  // 모든 카드 이미지를 미리 받아 디코딩해 둠 (참조를 유지해야 캐시에서 빠지지 않음)
  const preloaded = [];
  for (const f of [...[...'SHDC'].flatMap((s) => RANK_ORDER.map((r) => r + s)), 'BJ', 'CJ', 'back']) {
    const im = new Image();
    im.src = `cards/${f}.webp`;
    im.decode?.().catch(() => {});
    preloaded.push(im);
  }
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
      lastEventSeq = null;
      resultDismissed = false;
      overSeenAt = null;
      selected = [];
      if (g) feed.push({ sep: true, msg: `GAME ${state.gamesPlayed}` });
    }

    // 결과창에서 '이 방에 남기'를 고르면 대기실로
    if (!g || (!inGame && g.over) || (g.over && resultDismissed)) {
      show('lobby');
      for (const id of ['resultModal', 'forfeitModal']) $(id).classList.add('hidden');
      closePop();
      $('dangerGlow').classList.remove('on');
      $('lobbyCode').textContent = state.code;
      $('shareLink').value = shareUrl();
      $('memberList').innerHTML = '';
      for (const m of state.members) {
        const li = document.createElement('li');
        const idx = state.members.indexOf(m) + 1;
        li.innerHTML = `<span class="no">${String(idx).padStart(2, '0')}</span><span class="nm"></span><span class="tag"></span>`;
        li.children[1].textContent = m.name + (m.pid === pid ? ' (나)' : '');
        li.children[2].textContent = m.isBot ? 'COM' : [m.pid === state.hostPid ? '방장' : '', !m.connected ? '오프라인' : ''].filter(Boolean).join(' · ');
        if (m.pid === state.hostPid) li.children[2].classList.add('host');
        if (m.isBot) {
          li.classList.add('bot');
          li.children[2].classList.add('com');
          if (amHost) {
            const x = document.createElement('button');
            x.className = 'btn small ghost remove';
            x.textContent = '빼기';
            x.onclick = () => socket.emit('removeBot', m.pid);
            li.children[2].appendChild(x);
          }
        }
        $('memberList').appendChild(li);
      }
      $('memberCount').textContent = `${state.members.length} / 6`;
      $('turnTimeSel').value = String(state.turnTime);
      $('turnTimeSel').disabled = !amHost;
      $('startBtn').classList.toggle('hidden', !amHost);
      const n = state.members.filter((m) => m.connected).length;
      $('addBotBtn').classList.toggle('hidden', !amHost || n >= 6);
      if (amHost && pendingBots > 0) {
        for (let i = 0; i < pendingBots; i++) socket.emit('addBot');
        pendingBots = 0;
      }
      $('lobbyHint').textContent = amHost
        ? (n < 2 ? '링크로 친구를 초대하거나 컴퓨터를 추가하세요 (2~6명)' : `${n}명 준비 완료${n > 6 ? ' · 앞의 6명만 참가' : ''}`)
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
      d.dataset.pid = p.pid;
      if (member && member.isBot) d.classList.add('bot');
      const n = document.createElement('div');
      n.className = 'name';
      n.textContent = p.name;
      d.appendChild(n);
      const cnt = document.createElement('div');
      cnt.className = 'count';
      cnt.textContent = p.result === 'bankrupt' ? '파산' : p.result === 'forfeit' ? '포기' : p.out ? `${p.rank}등` : `${p.count}장`;
      d.appendChild(cnt);
      const mini = document.createElement('div');
      mini.className = 'mini-cards';
      for (let i = 0; i < Math.min(p.count, 10); i++) mini.appendChild(document.createElement('span'));
      d.appendChild(mini);
      if (p.oneCard) d.insertAdjacentHTML('beforeend', '<span class="badge alert">ONE?</span>');
      else if (p.result === 'finish' || p.result === 'last') d.insertAdjacentHTML('beforeend', `<span class="badge done">${p.rank}등</span>`);
      else if (p.result === 'bankrupt') d.insertAdjacentHTML('beforeend', '<span class="badge bust">파산</span>');
      else if (p.result === 'forfeit') d.insertAdjacentHTML('beforeend', '<span class="badge bust">포기</span>');
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
      // 착지 연출은 날아오는 카드가 도착한 뒤에 (runEvents 에서 실행)
      if (fresh) pendingLand = { el, lv: lv && g.pendingAttack > 0 ? lv : 0, total: g.pendingAttack };
      else el.classList.add('land');
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
    // 낼 수 있는 카드가 없으면 받기 버튼만 강조
    $('game').classList.toggle('only-draw', mine && g.playable.length === 0);
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
    $('drawBtn').disabled = !mine && !g.over;
    $('drawBtn').textContent = g.over ? '결과 보기' : g.pendingAttack > 0 ? `${g.pendingAttack}장 받기` : '카드 받기';
    const anyPending = g.players.some((p) => p.oneCard);
    $('oneCardBtn').classList.toggle('alert', anyPending);
    $('oneCardBtn').disabled = g.over || !me;
    $('forfeitBtn').classList.toggle('hidden', !me || me.out || g.over);
    if (!me || me.out || g.over) $('forfeitModal').classList.add('hidden');

    $('meInfo').textContent = me
      ? me.out ? (me.result === 'bankrupt' ? '파산했습니다 · 관전 중' : me.result === 'forfeit' ? '포기했습니다 · 관전 중' : `${me.rank}등으로 완주! 관전 중`) : `${myName || me.name} · ${me.count}장`
      : '관전 중 (다음 판부터 참가)';

    renderHand();
    renderLog();
    renderTimer();

    // 결과
    if (g.over && overSeenAt === null) {
      overSeenAt = Date.now();
      setTimeout(render, WIN_DELAY + 50);
    }
    if (g.over && !resultDismissed && Date.now() - overSeenAt >= WIN_DELAY) {
      const list = $('rankList');
      list.innerHTML = '';
      g.ranking.forEach((id) => {
        const p = g.players.find((x) => x.pid === id);
        const li = document.createElement('li');
        li.innerHTML = '<span class="nm"></span><span class="meta"></span>';
        li.children[0].textContent = p.name;
        li.children[1].textContent = [p.result === 'bankrupt' ? '파산' : p.result === 'forfeit' ? '포기' : '', id === pid ? '나' : ''].filter(Boolean).join(' · ');
        if (id === pid) li.children[1].classList.add('me');
        list.appendChild(li);
      });
      $('againBtn').classList.toggle('hidden', !amHost);
      $('resultHint').textContent = amHost
        ? '한 판 더 하면 1등이 선입니다. 이 방에 남거나 메인 홈으로 갈 수 있어요.'
        : '이 방에 남으면 방장이 다음 판을 시작할 때 함께 참가해요 (1등이 선).';
      $('resultModal').classList.remove('hidden');
    } else {
      $('resultModal').classList.add('hidden');
    }
  }

  // 손패 카드 요소는 다시 만들지 않고 재사용 (매번 새로 만들면 이미지가 잠깐 비어 보일 수 있음)
  const handEls = new Map();

  function renderHand() {
    const g = state?.game;
    const h = $('hand');
    h.innerHTML = '';
    if (!g || !g.hand) { handEls.clear(); return; }
    const ids = new Set(g.hand.map((c) => c.id));
    for (const id of handEls.keys()) if (!ids.has(id)) handEls.delete(id);
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
        let el = handEls.get(c.id);
        if (!el) {
          el = cardEl(c);
          el.dataset.id = c.id;
          handEls.set(c.id, el);
        }
        el.className = 'card';
        el.style.marginLeft = i > 0 ? `${step - cardW}px` : '';
        if (mine) el.classList.add(g.playable.includes(c.id) ? 'playable' : 'dim');
        if (pending && pending.ids.includes(c.id)) el.classList.add('gone');
        el.onpointerdown = (e) => { el._px = e.clientX; el._py = e.clientY; };
        el.onclick = (e) => {
          if (el._px != null && Math.hypot(e.clientX - el._px, e.clientY - el._py) > 12) return; // 스크롤하다 닿은 건 무시
          onCardTap(c, el);
        };
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

  // ---------- 카드 이동 애니메이션 ----------
  const CARD_R = 0.7175;
  const rectOf = (el) => (el ? el.getBoundingClientRect() : null);
  const centered = (r, w) => ({ left: r.left + r.width / 2 - w / 2, top: r.top + r.height / 2 - w / CARD_R / 2, width: w, height: w / CARD_R });

  function snapshotRects() {
    const hand = new Map();
    for (const el of document.querySelectorAll('#hand .card[data-id]')) hand.set(el.dataset.id, rectOf(el));
    return { hand };
  }

  function doLand(land) {
    if (!land) return;
    land.el.style.visibility = '';
    if (land.lv) attackSlam(land.el, land.lv, land.total);
    else {
      land.el.classList.add('land');
      thock();
    }
  }

  function runEvents(snap) {
    const g = state?.game;
    const land = pendingLand;
    pendingLand = null;
    const gameVisible = g && !$('game').classList.contains('hidden');
    if (!gameVisible || lastEventSeq === null || g.eventSeq < lastEventSeq) {
      if (g) lastEventSeq = g.eventSeq;
      return doLand(land);
    }
    const evs = g.events.filter((e) => e.seq > lastEventSeq);
    lastEventSeq = g.eventSeq;
    if (!evs.length) return doLand(land);

    const deck = rectOf($('deckPile').querySelector('.card.stack'));
    const pileEl = land ? land.el : $('discardPile').querySelector('.card');
    const pile = rectOf(pileEl);
    const handBox = rectOf($('hand'));
    const oppRect = (id) => rectOf(document.querySelector(`.opp[data-pid="${CSS.escape(id)}"]`));
    // 내가 새로 받은 카드: 도착할 때까지 숨겨 둠
    const fresh = [...$('hand').querySelectorAll('.card[data-id]')].filter((el) => !snap.hand.has(el.dataset.id));
    fresh.forEach((el) => el.classList.add('incoming'));
    let fi = 0;
    if (land) land.el.style.visibility = 'hidden';
    const lastPlay = [...evs].reverse().find((e) => e.type === 'play');
    let delay = 0;

    for (const e of evs) {
      const mine = e.pid === pid;
      if (e.type === 'play' && mine && pending && e.cards.some((c) => pending.ids.includes(c.id))) {
        clearTimeout(pending.timer);
        pending = null;
        if (opt) {
          opt.resolved = true;
          if (e === lastPlay) opt.land = land;
          finishOpt();
        } else if (e === lastPlay) doLand(land);
        delay += 120;
      } else if (e.type === 'play') {
        e.cards.forEach((c, i) => {
          const isFinal = e === lastPlay && i === e.cards.length - 1;
          const src = mine ? snap.hand.get(String(c.id)) : null;
          const o = oppRect(e.pid);
          const from = src || (o ? centered(o, 44) : handBox ? centered(handBox, pile.width) : pile);
          const slamNext = isFinal && land && land.lv;
          fly({
            face: c, from, to: pile, delay: delay + i * 110,
            mode: slamNext ? 'toSlam' : 'play',
            onStart: () => swish(0.5),
            onDone: isFinal ? () => doLand(land) : null,
          });
        });
        delay += (e.cards.length - 1) * 110 + 380;
      } else if (e.type === 'win') {
        const who = g.players.find((x) => x.pid === e.pid);
        setTimeout(() => winnerFx(who ? who.name : '', e.pid === pid), delay + 150);
      } else if (e.type === 'draw') {
        const attack = e.kind === 'attack';
        const penalty = e.kind === 'penalty';
        const k = Math.min(e.n, 10);
        const step = attack ? 70 : 90;
        for (let i = 0; i < k; i++) {
          let to;
          let target = null;
          if (mine && fresh[fi]) {
            target = fresh[fi++];
            to = rectOf(target);
          } else {
            const o = mine ? handBox : oppRect(e.pid);
            if (!o) continue;
            to = centered(o, mine ? deck.width : 40);
          }
          const tile = mine ? null : document.querySelector(`.opp[data-pid="${CSS.escape(e.pid)}"]`);
          fly({
            back: true, from: deck, to, delay: delay + i * step,
            mode: attack ? 'stab' : 'draw',
            onStart: () => (attack ? null : flick()),
            onDone: () => {
              if (target) {
                target.classList.remove('incoming');
                target.classList.add(attack || penalty ? 'stabbed' : 'arrive');
              }
              const hitEl = tile || $('hand');
              if (attack || penalty) {
                hitEl.classList.remove('hit');
                void hitEl.offsetWidth;
                hitEl.classList.add('hit');
                thud(attack ? 1 : 0.6);
              }
            },
          });
        }
        delay += (k - 1) * step + (attack ? 300 : 420) + 60;
      }
    }
    // 애니메이션 대상이 아니었던 나머지 새 카드는 바로 보여줌
    setTimeout(() => fresh.forEach((el) => el.classList.remove('incoming')), delay + 200);
    if (!lastPlay) doLand(land);
  }

  function fly({ face, back, from, to, delay = 0, mode = 'play', onStart, onDone, keep }) {
    if (!from || !to) { onDone && onDone(); return null; }
    const el = face ? cardEl(face) : document.createElement('div');
    el.classList.add('card', 'flyer');
    if (back) el.classList.add('back');
    Object.assign(el.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` });
    el.style.setProperty('--w', `${to.width}px`);
    document.body.appendChild(el);
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const s0 = Math.max(0.3, from.width / to.width);
    const start = `translate(${dx}px, ${dy}px) scale(${s0})`;
    let frames, duration, easing;
    if (mode === 'toSlam') {
      // 공격 카드: 바닥 위쪽 높이 솟구친 위치까지 날아간 뒤 슬램 연출로 이어짐
      frames = [{ transform: `${start} rotate(0deg)` }, { transform: 'translate(0, -140px) scale(2.1) rotate(-16deg)' }];
      duration = 300; easing = 'cubic-bezier(.3,.6,.4,1)';
    } else if (mode === 'stab') {
      // 공격받아 가져가는 카드: 빠르게 가속해서 꽂히듯
      frames = [
        { transform: `${start} rotate(-28deg)`, offset: 0 },
        { transform: `translate(${dx * 0.15}px, ${dy * 0.15 - 10}px) scale(1.18) rotate(6deg)`, offset: 0.8 },
        { transform: 'translate(0, 6px) scale(.92) rotate(0deg)', offset: 0.9 },
        { transform: 'none', offset: 1 },
      ];
      duration = 300; easing = 'cubic-bezier(.75,0,.95,.55)';
    } else if (mode === 'draw') {
      frames = [
        { transform: `${start} rotate(-6deg)` },
        { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 40}px) scale(${(s0 + 1) / 2 * 1.05}) rotate(4deg)`, offset: 0.5 },
        { transform: 'none' },
      ];
      duration = 420; easing = 'cubic-bezier(.4,0,.2,1)';
    } else {
      frames = [
        { transform: `${start} rotate(-10deg)` },
        { transform: 'translate(0, -18px) scale(1.08) rotate(3deg)', offset: 0.7 },
        { transform: 'none' },
      ];
      duration = 380; easing = 'cubic-bezier(.2,.7,.3,1)';
    }
    const anim = el.animate(frames, { duration, delay, easing, fill: 'both' });
    if (onStart) setTimeout(onStart, delay);
    anim.onfinish = () => { if (!keep) el.remove(); onDone && onDone(); };
    return el;
  }

  // 짧은 효과음들 (음원 파일 없이 생성)
  function noiseHit({ dur, freq, type = 'bandpass', vol, q = 1 }) {
    if (!soundOn) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = audioCtx;
      const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const gn = ctx.createGain();
      gn.gain.value = vol;
      src.connect(f).connect(gn).connect(ctx.destination);
      src.start();
    } catch {}
  }
  const swish = (v = 1) => noiseHit({ dur: 0.16, freq: 2600, vol: 0.25 * v, q: 0.7 });
  const flick = () => noiseHit({ dur: 0.07, freq: 3800, vol: 0.18, q: 1.2 });
  const thock = () => noiseHit({ dur: 0.06, freq: 1200, type: 'lowpass', vol: 0.35 });
  const thud = (v = 1) => noiseHit({ dur: 0.1, freq: 700, type: 'lowpass', vol: 0.55 * v });

  // ---------- 1등 Winner 연출 ----------
  function winnerFx(name, isMe) {
    const fx = $('winnerFx');
    fx.querySelector('.win-name').textContent = isMe ? `${name} · 축하해요!` : name;
    fx.classList.toggle('me', isMe);
    const conf = fx.querySelector('.confetti');
    conf.innerHTML = '';
    for (let i = 0; i < 36; i++) {
      const c = document.createElement('i');
      c.style.left = `${Math.random() * 100}%`;
      c.style.animationDelay = `${Math.random() * 0.6}s`;
      c.style.animationDuration = `${1.4 + Math.random() * 1.2}s`;
      c.style.background = ['#d3f170', '#ffffff', '#c7e261', '#ff5a4e', '#dcdcdc'][i % 5];
      c.style.transform = `rotate(${Math.random() * 360}deg)`;
      conf.appendChild(c);
    }
    fx.classList.remove('hidden', 'show');
    void fx.offsetWidth;
    fx.classList.add('show');
    fanfare();
    if (navigator.vibrate) navigator.vibrate([60, 40, 60, 40, 160]);
    setTimeout(() => fx.classList.add('hidden'), WIN_DELAY - 100);
  }

  function fanfare() {
    if (!soundOn) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audioCtx.currentTime + 0.05;
      // 도-미-솔-도↑ 상승 화음
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        const o = audioCtx.createOscillator();
        const gn = audioCtx.createGain();
        o.type = 'triangle';
        o.frequency.value = f;
        const t = t0 + i * 0.12;
        const len = i === 3 ? 0.7 : 0.22;
        gn.gain.setValueAtTime(0.0001, t);
        gn.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
        gn.gain.exponentialRampToValueAtTime(0.0001, t + len);
        o.connect(gn).connect(audioCtx.destination);
        o.start(t);
        o.stop(t + len + 0.05);
      });
    } catch {}
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
