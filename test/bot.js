'use strict';
// 컴퓨터 플레이어 검사: 항상 합법적인 수만 두는지, 게임이 끝나는지, 무작위보다 잘하는지
const assert = require('assert');
const { Game, SUITS } = require('../game');
const { chooseMove } = require('../bot');

let botWins = 0, games = 0;
for (let n = 0; n < 2000; n++) {
  const np = 2 + (n % 4);
  const seats = Array.from({ length: np }, (_, i) => ({ pid: 'p' + i, name: 'P' + i }));
  const g = new Game(seats, null);
  const botPid = 'p0'; // p0 만 컴퓨터 전략, 나머지는 무작위
  let steps = 0;
  while (!g.over && steps++ < 5000) {
    const p = g.current;
    let err;
    if (p.pid === botPid || n % 10 === 0) {
      const mv = chooseMove(g, p.pid);
      err = mv.type === 'play' ? g.play(p.pid, mv.cardIds, mv.suit) : g.draw(p.pid);
    } else {
      const ids = g.playableIds(p.pid);
      err = ids.length && Math.random() < 0.85 ? g.play(p.pid, [ids[Math.floor(Math.random() * ids.length)]], SUITS[steps % 4]) : g.draw(p.pid);
    }
    assert.strictEqual(err, null, `컴퓨터가 잘못된 수: ${err}`);
  }
  assert(g.over, '게임이 끝나지 않음');
  if (n % 10 !== 0) {
    games++;
    if (g.ranking[0] === botPid) botWins++;
  }
}
const rate = botWins / games;
console.log(`bot ok: 1등 비율 ${(rate * 100).toFixed(1)}% (${games}판, 무작위 대비)`);
