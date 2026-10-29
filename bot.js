'use strict';
// 컴퓨터 플레이어: 지금 상태에서 낼 카드(또는 받기)를 고른다.
const { ATTACK, SUITS } = require('./game');

const isJoker = (c) => c.rank === 'BJ' || c.rank === 'CJ';

// 남은 패에서 가장 많은 모양
function bestSuit(cards, fallback) {
  const count = { S: 0, H: 0, D: 0, C: 0 };
  for (const c of cards) if (c.suit) count[c.suit]++;
  let best = fallback;
  let max = -1;
  for (const s of SUITS) if (count[s] > max) { max = count[s]; best = s; }
  return max > 0 ? best : fallback || 'S';
}

function chooseMove(g, pid) {
  const p = g.player(pid);
  const hand = p.hand;
  const playable = g.playableIds(pid).map((id) => hand.find((c) => c.id === id));
  if (!playable.length) return { type: 'draw' };

  const defending = g.pendingAttack > 0;
  const next = g.players[g.nextIndex(g.turn)];
  const nextDanger = next && next.pid !== pid && next.hand.length <= 2; // 다음 사람이 거의 다 털었으면 공격
  const suitCount = { S: 0, H: 0, D: 0, C: 0 };
  for (const c of hand) if (c.suit) suitCount[c.suit]++;

  const score = (c) => {
    let s = 10 + Math.random() * 3;
    const atk = ATTACK[c.rank] || 0;
    if (defending) {
      s += 50 - atk; // 막을 땐 가장 약한 카드부터
    } else if (atk) {
      s += nextDanger ? 25 + atk : -6 - atk * 2; // 평소엔 공격 카드를 아껴 둠
    }
    if (c.rank === 'J' || c.rank === 'Q') s += nextDanger ? 15 : 0;
    if (c.rank === 'K' && suitCount[c.suit] > 1) s += 8; // 이어서 낼 카드가 있으면 K
    if (c.rank === '7') s += suitCount[g.top.suit] <= 1 ? 4 : -3;
    if (c.suit) s += suitCount[c.suit] * 1.5; // 많은 모양부터 정리
    return s;
  };

  const scored = playable.map((c) => ({ c, s: score(c) }));
  let best = scored.reduce((a, b) => (b.s > a.s ? b : a)).c;
  let ids = [best.id];

  // 같은 숫자 여러 장: 바닥과 같은 숫자면 한꺼번에 털기
  if (!g.kChain && !isJoker(g.top)) {
    const same = hand.filter((c) => c.rank === g.top.rank);
    if (same.length > 1) {
      // 가장 많은 모양의 카드를 마지막(맨 위)에 둠
      same.sort((a, b) => suitCount[a.suit] - suitCount[b.suit]);
      const setIds = same.map((c) => c.id);
      if (!g.validate(pid, setIds) && (defending || !same.some((c) => ATTACK[c.rank]) || nextDanger || same.length >= 3)) {
        ids = setIds;
        best = same[same.length - 1];
      }
    }
  }

  let suit;
  if (best.rank === '7') {
    const rest = hand.filter((c) => !ids.includes(c.id));
    suit = bestSuit(rest, best.suit);
  }
  return { type: 'play', cardIds: ids, suit };
}

module.exports = { chooseMove };
