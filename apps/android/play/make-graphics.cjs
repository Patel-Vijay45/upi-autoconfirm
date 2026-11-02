// Re-creates icon-512.png and feature-graphic.png: node apps/android/play/make-graphics.cjs apps/android/play
const { chromium } = require('playwright');
const out = process.argv[2];
const check = (size, stroke1, stroke2) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 108 108">
  <path fill="none" stroke="#fff" stroke-width="${stroke1}" d="M54,30a24,24 0 1,0 0.01,0z"/>
  <path fill="none" stroke="#fff" stroke-width="${stroke2}" stroke-linecap="round" stroke-linejoin="round" d="M42,55 L51,64 L67,46"/>
</svg>`;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ deviceScaleFactor: 1 });
  // App icon: 512×512, full square (Play applies its own mask).
  await p.setViewportSize({ width: 512, height: 512 });
  await p.setContent(`<html><body style="margin:0;background:#1B5E20;display:grid;place-items:center;width:512px;height:512px">
    <div style="transform:scale(1.55);display:grid;place-items:center">${check(512, 5, 6)}</div></body></html>`);
  await p.screenshot({ path: `${out}/icon-512.png`, omitBackground: false });
  // Feature graphic: 1024×500, no transparency.
  await p.setViewportSize({ width: 1024, height: 500 });
  await p.setContent(`<html><body style="margin:0;width:1024px;height:500px;background:linear-gradient(135deg,#1B5E20,#2E7D32 60%,#388E3C);font-family:Roboto,Arial,sans-serif;color:#fff;display:flex;align-items:center;gap:40px;padding:0 70px;box-sizing:border-box">
    <div style="flex:none;width:220px;height:220px;border-radius:48px;background:rgba(255,255,255,.12);display:grid;place-items:center">${check(220, 5, 6)}</div>
    <div>
      <div style="font-size:64px;font-weight:700;letter-spacing:-1px">AutoConfirm</div>
      <div style="font-size:31px;margin-top:14px;line-height:1.3;opacity:.95">UPI payments to your shop,<br>confirmed automatically</div>
      <div style="font-size:22px;margin-top:22px;opacity:.85">Your own UPI ID · No gateway · No % fee</div>
    </div></body></html>`);
  await p.screenshot({ path: `${out}/feature-graphic.png` });
  await b.close();
})();
