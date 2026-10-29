'use strict';
// 원카드 게임 엔진 (서버 권한형). 네트워크와 무관한 순수 로직.

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUIT_NAME = { S: '♠', H: '♥', D: '♦', C: '♣' };

// 공격 카드와 먹어야 하는 장수
const ATTACK = { '2': 2, A: 3, BJ: 5, CJ: 7 };

const HAND_SIZE = 7;
const BANKRUPT_AT = 20;

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function makeDeck() {
  const deck = [];
  let id = 0;
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ id: id++, suit, rank });
  deck.push({ id: id++, suit: null, rank: 'BJ' }); // 흑백 조커
  deck.push({ id: id++, suit: null, rank: 'CJ' }); // 컬러 조커
  return shuffle(deck);
}

const isJoker = (c) => c.rank === 'BJ' || c.rank === 'CJ';
const isAttack = (c) => ATTACK[c.rank] !== undefined;

function cardLabel(c) {
  if (c.rank === 'BJ') return '흑백조커';
  if (c.rank === 'CJ') return '컬러조커';
  return SUIT_NAME[c.suit] + c.rank;
}

// 공격 중인 top 카드를 card 로 막을 수 있는지
function canDefend(top, card) {
  switch (top.rank) {
    case '2':
      return card.rank === '2' || (card.rank === 'A' && card.suit === top.suit) || isJoker(card);
    case 'A':
      return card.rank === 'A' || isJoker(card);
    case 'BJ':
      return (card.rank === 'A' && card.suit === 'S') || card.rank === 'CJ';
    default: // 컬러조커는 막을 수 없음
      return false;
  }
}

class Game {
  /**
   * @param {{pid:string,name:string}[]} seats 좌석 순서(시계방향)
   * @param {string|null} firstPid 선 플레이어 (null 이면 랜덤)
   */
  constructor(seats, firstPid) {
    this.players = seats.map((s) => ({ pid: s.pid, name: s.name, hand: [], out: false, result: null }));
    this.deck = makeDeck();
    this.discard = [];
    this.direction = 1; // 1 = 시계방향, -1 = 반시계
    this.pendingAttack = 0;
    this.declaredSuit = null; // 7 로 바꾼 모양
    this.kChain = null; // K 를 낸 뒤 이어서 낼 때 { suit }
    this.oneCard = new Set(); // 원카드 선언 대기 중인 pid
    this.finished = []; // 패를 다 털어낸 순서
    this.bankrupt = []; // 파산 순서
    this.log = [];
    this.logSeq = 0;
    this.turnSeq = 0;
    this.over = false;
    this.ranking = null;

    for (let i = 0; i < HAND_SIZE; i++) for (const p of this.players) p.hand.push(this.deck.pop());

    // 시작 카드는 기능 없는 숫자 카드로
    for (;;) {
      const c = this.deck.pop();
      if (!isJoker(c) && !isAttack(c) && !['7', 'J', 'Q', 'K'].includes(c.rank)) {
        this.discard.push(c);
        break;
      }
      this.deck.unshift(c);
    }

    let idx = firstPid ? this.players.findIndex((p) => p.pid === firstPid) : -1;
    if (idx < 0) idx = Math.floor(Math.random() * this.players.length);
    this.turn = idx;
    this.turnSeq++;
    this.addLog(`게임 시작! ${this.players[idx].name} 님이 먼저 시작합니다. 시작 카드: ${cardLabel(this.top)}`);
  }

  get top() {
    return this.discard[this.discard.length - 1];
  }

  get current() {
    return this.players[this.turn];
  }

  player(pid) {
    return this.players.find((p) => p.pid === pid);
  }

  addLog(msg) {
    this.log.push({ seq: ++this.logSeq, msg });
    if (this.log.length > 60) this.log.shift();
  }

  activePlayers() {
    return this.players.filter((p) => !p.out);
  }

  // from 에서 진행방향으로 steps 칸 (탈락자 건너뜀)
  nextIndex(from, steps = 1) {
    let i = from;
    const n = this.players.length;
    for (let s = 0; s < steps; s++) {
      let guard = 0;
      do {
        i = (i + this.direction + n) % n;
      } while (this.players[i].out && ++guard <= n);
    }
    return i;
  }

  setTurn(i) {
    this.turn = i;
    this.turnSeq++;
  }

  // 덱에서 n 장. 덱이 비면 바닥 카드(맨 위 제외)를 섞어 덱으로.
  drawCards(p, n) {
    let drawn = 0;
    for (let i = 0; i < n; i++) {
      if (this.deck.length === 0) {
        if (this.discard.length <= 1) break;
        const top = this.discard.pop();
        this.deck = shuffle(this.discard);
        this.discard = [top];
        this.addLog('덱이 떨어져 낸 카드들을 섞어 새 덱을 만들었습니다.');
      }
      p.hand.push(this.deck.pop());
      drawn++;
    }
    if (p.hand.length !== 1) this.oneCard.delete(p.pid);
    return drawn;
  }

  checkBankrupt(p) {
    if (p.out || p.hand.length < BANKRUPT_AT) return false;
    p.out = true;
    p.result = 'bankrupt';
    this.bankrupt.push(p.pid);
    this.oneCard.delete(p.pid);
    // 파산자의 카드는 덱 밑으로 섞어 넣음
    this.deck = shuffle(this.deck.concat(p.hand));
    p.hand = [];
    this.addLog(`💥 ${p.name} 님 파산! (패 ${BANKRUPT_AT}장 이상)`);
    return true;
  }

  // 남은 사람이 1명 이하면 게임 종료
  checkEnd() {
    const active = this.activePlayers();
    if (active.length > 1) return false;
    for (const p of active) {
      p.out = true;
      p.result = p.result || 'last';
      this.finished.push(p.pid);
    }
    this.over = true;
    this.pendingAttack = 0;
    this.kChain = null;
    this.ranking = [...this.finished, ...[...this.bankrupt].reverse()];
    const winner = this.player(this.ranking[0]);
    this.addLog(`🏆 게임 종료! 1등: ${winner.name}`);
    return true;
  }

  // 단일 카드 내기 가능 여부 (힌트용)
  playableIds(pid) {
    const p = this.player(pid);
    if (!p || this.over || this.current.pid !== pid) return [];
    return p.hand.filter((c) => !this.validate(pid, [c.id])).map((c) => c.id);
  }

  // 오류 메시지 반환, 가능하면 null
  validate(pid, cardIds) {
    if (this.over) return '게임이 끝났습니다.';
    const p = this.player(pid);
    if (!p || p.out) return '참가 중이 아닙니다.';
    if (this.current.pid !== pid) return '내 차례가 아닙니다.';
    if (!Array.isArray(cardIds) || cardIds.length === 0) return '낼 카드를 선택하세요.';
    if (new Set(cardIds).size !== cardIds.length) return '잘못된 선택입니다.';
    const cards = cardIds.map((id) => p.hand.find((c) => c.id === id));
    if (cards.some((c) => !c)) return '패에 없는 카드입니다.';

    const top = this.top;

    // K 다음: 같은 모양 한 장, 또는 다른 모양의 K (K 는 같은 숫자라 여러 장도 가능)
    if (this.kChain) {
      if (cards.every((c) => c.rank === 'K')) return null;
      if (cards.length > 1) return 'K 다음에는 같은 모양 한 장 또는 K 만 낼 수 있습니다.';
      if (cards[0].suit !== this.kChain.suit) return `K 다음에는 같은 모양(${SUIT_NAME[this.kChain.suit]}) 또는 K 만 낼 수 있습니다.`;
      return null;
    }

    // 여러 장은 바닥에 깔린 숫자와 같은 숫자일 때만
    if (cards.length > 1) {
      if (isJoker(top)) return '여러 장은 바닥과 같은 숫자일 때만 낼 수 있습니다.';
      if (!cards.every((c) => c.rank === top.rank)) return '여러 장은 바닥에 깔린 카드와 같은 숫자일 때만 동시에 낼 수 있습니다.';
    }

    if (this.pendingAttack > 0) {
      if (!cards.every((c) => canDefend(top, c))) {
        if (top.rank === 'CJ') return '컬러조커 공격은 막을 수 없습니다. 카드를 받으세요.';
        if (top.rank === 'BJ') return '흑백조커는 ♠A 또는 컬러조커로만 막을 수 있습니다.';
        if (top.rank === 'A') return 'A 공격은 A 또는 조커로만 막을 수 있습니다.';
        return '2 공격은 2, 같은 모양 A, 조커로만 막을 수 있습니다.';
      }
      return null;
    }

    const c = cards[0];
    if (isJoker(c) || isJoker(top)) return null;
    if (this.declaredSuit) {
      if (c.suit === this.declaredSuit || c.rank === '7') return null;
      return `모양이 ${SUIT_NAME[this.declaredSuit]}(으)로 바뀌었습니다.`;
    }
    if (c.suit === top.suit || c.rank === top.rank) return null;
    return '모양이나 숫자가 맞지 않습니다.';
  }

  play(pid, cardIds, suit) {
    const err = this.validate(pid, cardIds);
    if (err) return err;
    const p = this.player(pid);
    const cards = cardIds.map((id) => p.hand.find((c) => c.id === id));
    p.hand = p.hand.filter((c) => !cardIds.includes(c.id));
    for (const c of cards) this.discard.push(c);
    const last = cards[cards.length - 1];

    this.declaredSuit = null;
    this.kChain = null;

    const atk = cards.reduce((s, c) => s + (ATTACK[c.rank] || 0), 0);
    this.pendingAttack += atk;

    let msg = `${p.name}: ${cards.map(cardLabel).join(', ')}`;
    if (atk) msg += ` → 공격 누적 ${this.pendingAttack}장`;

    if (last.rank === '7') {
      this.declaredSuit = SUITS.includes(suit) ? suit : last.suit;
      msg += ` → 모양 변경 ${SUIT_NAME[this.declaredSuit]}`;
    }

    if (p.hand.length === 1) this.oneCard.add(p.pid);
    else this.oneCard.delete(p.pid);

    if (p.hand.length === 0) {
      p.out = true;
      p.result = 'finish';
      this.finished.push(p.pid);
      this.addLog(msg);
      this.addLog(`🎉 ${p.name} 님 ${this.finished.length}등!`);
      if (this.checkEnd()) return null;
      // 카드 효과(J/Q)는 그대로 적용
    } else {
      this.addLog(msg);
    }

    const jumps = cards.filter((c) => c.rank === 'J').length;
    const reverses = cards.filter((c) => c.rank === 'Q').length;

    if (last.rank === 'K' && !p.out) {
      this.kChain = { suit: last.suit };
      this.addLog(`${p.name} 님 K! 같은 모양(${SUIT_NAME[last.suit]})으로 한 번 더`);
      this.turnSeq++; // 타이머 리셋
      return null;
    }
    if (reverses % 2 === 1) {
      this.direction *= -1;
      this.addLog(`🔄 방향 전환 (${this.direction === 1 ? '시계방향' : '반시계방향'})`);
    }
    if (jumps) {
      const skipped = [];
      let i = this.turn;
      for (let k = 0; k < jumps; k++) {
        i = this.nextIndex(i);
        skipped.push(this.players[i].name);
      }
      this.addLog(`⏭ 점프! ${skipped.join(', ')} 님 건너뜀`);
      this.setTurn(this.nextIndex(i));
    } else {
      this.setTurn(this.nextIndex(this.turn));
    }
    return null;
  }

  // 카드 받기 (공격 받기 / 낼 카드 없음 / K 뒤에 낼 카드 없음)
  draw(pid) {
    if (this.over) return '게임이 끝났습니다.';
    const p = this.player(pid);
    if (!p || p.out) return '참가 중이 아닙니다.';
    if (this.current.pid !== pid) return '내 차례가 아닙니다.';
    const n = this.pendingAttack > 0 ? this.pendingAttack : 1;
    const got = this.drawCards(p, n);
    if (this.pendingAttack > 0) this.addLog(`💣 ${p.name} 님 공격을 받아 ${got}장 먹음`);
    else if (this.kChain) this.addLog(`${p.name} 님 K 뒤에 낼 카드가 없어 1장 받음`);
    else this.addLog(`${p.name} 님 1장 받음`);
    this.pendingAttack = 0;
    this.kChain = null;
    this.checkBankrupt(p);
    if (this.checkEnd()) return null;
    this.setTurn(this.nextIndex(this.turn));
    return null;
  }

  // 원카드 버튼
  callOneCard(pid) {
    if (this.over) return null;
    const p = this.player(pid);
    if (!p) return null;
    if (this.oneCard.has(pid)) {
      this.oneCard.delete(pid);
      this.addLog(`☝️ ${p.name} 님 원카드!`);
      return null;
    }
    const caught = [...this.oneCard].map((id) => this.player(id));
    if (caught.length === 0) return null;
    for (const t of caught) {
      this.oneCard.delete(t.pid);
      this.drawCards(t, 1);
      this.addLog(`🚨 ${p.name} 님이 ${t.name} 님의 원카드를 먼저 외쳤습니다! ${t.name} 님 1장 받음`);
      this.checkBankrupt(t);
    }
    if (this.checkEnd()) return null;
    // 차례인 사람이 파산했으면 다음 사람에게
    if (this.current.out) this.setTurn(this.nextIndex(this.turn));
    return null;
  }

  // 시간 초과: 자동으로 카드 받기
  timeout() {
    if (this.over) return;
    const p = this.current;
    this.addLog(`⏰ ${p.name} 님 시간 초과`);
    this.draw(p.pid);
  }

  view(pid) {
    const me = this.player(pid);
    return {
      players: this.players.map((p) => ({
        pid: p.pid,
        name: p.name,
        count: p.hand.length,
        out: p.out,
        result: p.result,
        rank: this.ranking ? this.ranking.indexOf(p.pid) + 1 : this.finished.includes(p.pid) ? this.finished.indexOf(p.pid) + 1 : null,
        oneCard: this.oneCard.has(p.pid),
      })),
      turnPid: this.over ? null : this.current.pid,
      direction: this.direction,
      top: this.top,
      declaredSuit: this.declaredSuit,
      pendingAttack: this.pendingAttack,
      kChain: this.kChain,
      deckCount: this.deck.length,
      discardCount: this.discard.length,
      hand: me ? me.hand : null,
      playable: me ? this.playableIds(pid) : [],
      log: this.log.slice(-30),
      over: this.over,
      ranking: this.ranking,
      turnSeq: this.turnSeq,
    };
  }
}

module.exports = { Game, makeDeck, canDefend, cardLabel, ATTACK, BANKRUPT_AT, SUITS };
