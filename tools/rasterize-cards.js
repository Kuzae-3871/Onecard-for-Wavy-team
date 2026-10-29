'use strict';
// assets/cards-svg/*.svg → public/cards/*.webp (가볍고 빨리 그려지는 래스터 이미지로 변환)
// 실행: node tools/rasterize-cards.js  (playwright 필요)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SRC = path.join(__dirname, '..', 'assets', 'cards-svg');
const OUT = path.join(__dirname, '..', 'public', 'cards');
const W = 360;
const H = Math.round(W / (224.225 / 312.808));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<canvas id="c"></canvas>');
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.svg'));
  for (const f of files) {
    const svg = fs.readFileSync(path.join(SRC, f), 'utf8');
    const dataUrl = await page.evaluate(async ({ svg, W, H }) => {
      const img = new Image();
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
      await img.decode();
      const c = document.getElementById('c');
      c.width = W;
      c.height = H;
      const x = c.getContext('2d');
      x.clearRect(0, 0, W, H);
      x.drawImage(img, 0, 0, W, H);
      return c.toDataURL('image/webp', 0.92);
    }, { svg, W, H });
    fs.writeFileSync(path.join(OUT, f.replace('.svg', '.webp')), Buffer.from(dataUrl.split(',')[1], 'base64'));
  }
  console.log(`${files.length} cards → ${W}x${H} webp`);
  await browser.close();
})();
