// 적용 후 검증: renderer/style.css에서 토큰을 파싱해 전체 대비 쌍을 재계산
const fs = require('fs');
const css = fs.readFileSync(require('path').join(__dirname, '..', 'renderer', 'style.css'), 'utf8');

function blockVars(sel) {
  const re = new RegExp(sel.replace(/[[\]()*+?.\\^$|]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 's');
  const m = css.match(re);
  const vars = {};
  if (!m) return vars;
  for (const d of m[1].split(';')) {
    const mm = d.match(/(--[\w-]+)\s*:\s*(.+)/s);
    if (mm) vars[mm[1]] = mm[2].trim();
  }
  return vars;
}
const light = blockVars(':root');
const dark = { ...light, ...blockVars(':root[data-theme="dark"]') };

function hex2rgb(h){h=h.replace('#','');if(h.length===3)h=h.split('').map(c=>c+c).join('');return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];}
function parseColor(v, vars) {
  v = v.trim();
  const vm = v.match(/^var\((--[\w-]+)\)$/);
  if (vm) return parseColor(vars[vm[1]], vars);
  if (v.startsWith('#')) return { rgb: hex2rgb(v), a: 1 };
  const rm = v.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
  if (rm) return { rgb: [+rm[1], +rm[2], +rm[3]], a: rm[4] !== undefined ? +rm[4] : 1 };
  const cm = v.match(/color-mix\(in srgb,\s*(.+?)\s+(\d+)%\s*,\s*(.+)\)$/);
  if (cm) {
    const c1 = parseColor(cm[1], vars), c2 = parseColor(cm[3], vars), p = +cm[2] / 100;
    return { rgb: c1.rgb.map((x, i) => x * p + c2.rgb[i] * (1 - p)), a: 1 };
  }
  throw new Error('cannot parse: ' + v);
}
function over(fg, bg) { return fg.rgb.map((v, i) => v * fg.a + bg[i] * (1 - fg.a)); }
function lum(rgb){const a=rgb.map(v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);});return 0.2126*a[0]+0.7152*a[1]+0.0722*a[2];}
function ratio(f, b) { const l1 = lum(f), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }

// (라벨, 전경var, 배경var 또는 [틴트var, 알파적용, 아래배경var]) — thr 기본 4.5
function run(theme, vars) {
  const solid = (name) => parseColor(vars[name], vars).rgb;
  const tinted = (fgName, bgName) => { const t = parseColor(vars[fgName], vars); return over(t, solid(bgName)); };
  const pairs = [
    ['ink/bg', solid('--ink'), solid('--bg')],
    ['ink/card', solid('--ink'), solid('--card')],
    ['ink-2/card', solid('--ink-2'), solid('--card')],
    ['muted-s/card', solid('--muted-s'), solid('--card')],
    ['muted-s/bg', solid('--muted-s'), solid('--bg')],
    ['faint/card', solid('--faint'), solid('--card')],
    ['faint/bg', solid('--faint'), solid('--bg')],
    ['accent-ink/bg', solid('--accent-ink'), solid('--bg')],
    ['accent-ink/accent-soft+card', solid('--accent-ink'), tinted('--accent-soft', '--card')], // 칩은 카드/패널 위에 얹힘
    ['on-accent/accent', solid('--on-accent'), solid('--accent')],
    ['on-primary/primary', solid('--on-primary'), solid('--primary')],
    ['muted-s/panel', solid('--muted-s'), solid('--panel')],
    ['faint/panel', solid('--faint'), solid('--panel')],
    ['muted-s/card-2', solid('--muted-s'), solid('--card-2')],
    ['faint/card-2', solid('--faint'), solid('--card-2')],
    ['ink-2/card-2', solid('--ink-2'), solid('--card-2')],
    ['muted-s/surface', solid('--muted-s'), solid('--surface')],
    ['faint/surface', solid('--faint'), solid('--surface')],
    ['pk/pk-bg+card', solid('--pk'), tinted('--pk-bg', '--card')],
    ['danger/danger-surface', solid('--danger'), parseColor(vars['--danger-surface'], vars).rgb],
    ['danger/card', solid('--danger'), solid('--card')],
  ];
  const tintA = parseFloat(vars['--tint-chip']) / 100; // 테마별 칩 틴트
  const selfTint = (name) => over({ rgb: solid(name), a: tintA }, solid('--card'));
  for (const t of ['comp','own','req','auth','share','ment','hier','ref']) {
    pairs.push([`t-${t}/card`, solid(`--t-${t}`), solid('--card')]);
    pairs.push([`t-${t}/tint+card`, solid(`--t-${t}`), selfTint(`--t-${t}`)]);
  }
  pairs.push(['real/tint+card', solid('--real'), selfTint('--real')]);
  pairs.push(['logical/tint+card', solid('--logical'), selfTint('--logical')]);
  pairs.push(['uq/uq-bg+card', solid('--uq'), tinted('--uq-bg', '--card')]);
  for (let i = 0; i <= 9; i++) pairs.push([`gc-${i}/card`, solid(`--gc-${i}`), solid('--card')]);
  for (let i = 0; i <= 9; i++) pairs.push([`gc-${i}/surface`, solid(`--gc-${i}`), solid('--surface')]); // 헐 라벨은 서페이스 위에 그려짐
  // 솔리드 카드 헤더의 타이틀 텍스트 (dbdiagram 문법)
  for (const gv of [...Array.from({ length: 10 }, (_, i) => `--gc-${i}`), '--gc-x'])
    pairs.push([`hd-ink/${gv.slice(2)}`, solid('--hd-ink'), solid(gv)]);
  let fail = 0;
  for (const [name, f, b] of pairs) {
    const r = ratio(lum ? f : f, b); // eslint 무시
    const rr = +ratio(f, b).toFixed(2);
    const ok = rr >= 4.5;
    if (!ok) fail++;
    console.log(`${ok ? ' ok ' : 'FAIL'} [${theme}] ${name.padEnd(26)} ${rr}`);
  }
  return fail;
}
const f1 = run('light', light);
const f2 = run('dark', dark);
console.log(`\nfails: light=${f1} dark=${f2}`);
process.exit(f1 + f2 ? 1 : 0);
