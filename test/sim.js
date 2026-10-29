'use strict';
// 무작위 봇으로 수천 판을 돌려 엔진 불변식 검사
const assert = require('assert');
const { Game, canDefend, SUITS } = require('../game');

const C = (suit, rank) => ({ id: -1, suit, rank });
// 규칙 단위 검사
assert(canDefend(C('H', 'A'), C('S', 'A')));
assert(canDefend(C('H', 'A'), C(null, 'BJ')));
assert(!canDefend(C('H', 'A'), C('H', '2')));
assert(canDefend(C(null, 'BJ'), C('S', 'A')));
assert(!canDefend(C(null, 'BJ'), C('H', 'A')));
assert(canDefend(C(null, 'BJ'), C(null, 'CJ')));
assert(!canDefend(C(null, 'CJ'), C('S', 'A')));

function scenario() {
  const g = new Game([{ pid: 'a', name: 'A' }, { pid: 'b', name: 'B' }, { pid: 'c', name: 'C' }], 'a');
  const [a, b, c] = g.players;
  // 바닥 ♥5, a 패에 ♠5, ♦5 → 동시에 낼 수 있음
  g.discard.push({ id: 900, suit: 'H', rank: '5' });
  a.hand = [{ id: 901, suit: 'S', rank: '5' }, { id: 902, suit: 'D', rank: '5' }, { id: 903, suit: 'D', rank: '9' }, { id: 904, suit: 'C', rank: '3' }];
  assert.strictEqual(g.validate('a', [903, 902]), '여러 장은 바닥에 깔린 카드와 같은 숫자일 때만 동시에 낼 수 있습니다.');
  assert.strictEqual(g.play('a', [901, 902]), null);
  assert.strictEqual(g.turn, 1);
  // b: 흑백조커, c: ♠A 막기 → a 8장
  b.hand.push({ id: 910, suit: null, rank: 'BJ' });
  assert.strictEqual(g.play('b', [910]), null);
  c.hand.push({ id: 911, suit: 'H', rank: 'A' }, { id: 912, suit: 'S', rank: 'A' });
  assert(g.validate('c', [911]));
  assert.strictEqual(g.play('c', [912]), null);
  assert.strictEqual(g.pendingAttack, 8);
  const before = a.hand.length;
  g.draw('a');
  assert.strictEqual(a.hand.length, before + 8);
  // b 차례, K 후 같은 모양만
  b.hand.push({ id: 920, suit: 'S', rank: 'K' }, { id: 921, suit: 'H', rank: '3' }, { id: 922, suit: 'S', rank: '4' });
  assert.strictEqual(g.play('b', [920]), null);
  assert.strictEqual(g.current.pid, 'b');
  assert(g.validate('b', [921]));
  // K 다음 다른 모양 K → 다시 그 K 모양으로 한 번 더
  b.hand.push({ id: 923, suit: 'H', rank: 'K' }, { id: 924, suit: 'H', rank: '6' });
  assert.strictEqual(g.play('b', [923]), null);
  assert.strictEqual(g.current.pid, 'b');
  assert.deepStrictEqual(g.kChain, { suit: 'H' });
  assert(g.validate('b', [922]));
  assert.strictEqual(g.play('b', [924]), null);
  assert.strictEqual(g.current.pid, 'c');
  g.setTurn(1);
  b.hand.push({ id: 925, suit: 'H', rank: '9' }, { id: 926, suit: 'S', rank: '9' });
  g.discard.push({ id: 927, suit: 'S', rank: '3' });
  g.kChain = { suit: 'S' };
  assert(g.validate('b', [925])); // 다른 모양 일반 카드는 불가
  assert(g.validate('b', [926, 925])); // 여러 장 불가 (K 가 아님)
  assert.strictEqual(g.play('b', [922]), null);
  assert.strictEqual(g.current.pid, 'c');
  // Q: 방향 반대, c 차례 끝 → b
  c.hand.push({ id: 930, suit: 'S', rank: 'Q' });
  g.play('c', [930]);
  assert.strictEqual(g.direction, -1);
  assert.strictEqual(g.current.pid, 'b');
  // J: 점프 (반시계: b → a 건너뛰고 c), 다시 c 의 J 로 b 건너뛰고 a
  b.hand.push({ id: 940, suit: 'S', rank: 'J' });
  g.play('b', [940]);
  assert.strictEqual(g.current.pid, 'c');
  c.hand.push({ id: 941, suit: 'C', rank: 'J' });
  g.play('c', [941]);
  assert.strictEqual(g.current.pid, 'a');
  // 원카드: 다른 사람이 먼저 누르면 1장
  a.hand = [{ id: 950, suit: 'C', rank: '8' }, { id: 951, suit: 'S', rank: '9' }];
  assert.strictEqual(g.play('a', [950]), null);
  assert(g.oneCard.has('a'));
  g.callOneCard('c');
  assert.strictEqual(a.hand.length, 2);
  // 시간 초과: 기본 1장 + 패널티 1장 = 2장, 공격 중이면 누적 + 1장
  const cur = g.current;
  let n0 = cur.hand.length;
  g.timeout();
  assert.strictEqual(cur.hand.length, n0 + 2);
  const nxt = g.current;
  g.pendingAttack = 3;
  n0 = nxt.hand.length;
  g.timeout();
  assert.strictEqual(nxt.hand.length, n0 + 4);
  assert.strictEqual(g.pendingAttack, 0);
  // 포기: 차례였던 사람이 포기하면 다음 사람 차례, 꼴등
  {
    const g2 = new Game([{ pid: 'x', name: 'X' }, { pid: 'y', name: 'Y' }, { pid: 'z', name: 'Z' }], 'x');
    assert.strictEqual(g2.forfeit('x'), null);
    assert.strictEqual(g2.current.pid, 'y');
    assert(g2.forfeit('x')); // 두 번은 불가
    g2.player('y').hand = [{ id: 990, suit: g2.top.suit, rank: '3' }];
    g2.play('y', [990]); // y 1등 → z 혼자 남아 종료
    assert(g2.over);
    assert.deepStrictEqual(g2.ranking, ['y', 'z', 'x']);
  }
  console.log('scenario ok');
}
scenario();

let games = 0, turns = 0;
for (let n = 0; n < 3000; n++) {
  const np = 2 + (n % 5);
  const seats = Array.from({ length: np }, (_, i) => ({ pid: 'p' + i, name: 'P' + i }));
  const g = new Game(seats, null);
  let steps = 0;
  while (!g.over && steps++ < 5000) {
    const p = g.current;
    assert(!p.out);
    const ids = g.playableIds(p.pid);
    // 같은 숫자 여러 장 시도
    const top = g.top;
    const same = p.hand.filter((c) => c.rank === top.rank).map((c) => c.id);
    let err;
    if (same.length > 1 && Math.random() < 0.7 && !g.validate(p.pid, same)) err = g.play(p.pid, same, SUITS[n % 4]);
    else if (ids.length && Math.random() < 0.9) err = g.play(p.pid, [ids[Math.floor(Math.random() * ids.length)]], SUITS[steps % 4]);
    else err = g.draw(p.pid);
    assert.strictEqual(err, null, err);
    if (Math.random() < 0.03 && !g.over) g.timeout();
    if (Math.random() < 0.004 && !g.over) g.forfeit(g.players[Math.floor(Math.random() * np)].pid);
    if (Math.random() < 0.1) g.callOneCard(g.players[Math.floor(Math.random() * np)].pid);
    const total = g.deck.length + g.discard.length + g.players.reduce((s, x) => s + x.hand.length, 0);
    assert.strictEqual(total, 54, 'card conservation');
    const ids2 = new Set([...g.deck, ...g.discard, ...g.players.flatMap((x) => x.hand)].map((c) => c.id));
    assert.strictEqual(ids2.size, 54);
    turns++;
  }
  if (!g.over) { console.log('stuck', steps); continue; }
  assert.strictEqual(g.ranking.length, np);
  games++;
}
console.log(`${games} games, ${turns} actions ok`);
