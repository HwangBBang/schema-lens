// npm 배포용 패키지를 dist-npm/ 으로 조립한다.
//
// 실행: npm run npm:build   (배포는 npm run npm:publish)
//
// 왜 저장소를 그대로 publish 하지 않나:
//  1) electron-builder 는 electron 이 dependencies 에 있으면 빌드를 거부한다(하드 에러, 우회 불가).
//     그런데 npm 설치본은 electron 이 dependencies 여야 실행된다. 한 package.json 으로 둘 다
//     만족시킬 수 없어서, 배포용 package.json 을 여기서 따로 만든다.
//  2) 저장소에는 .npmignore 가 없어 .gitignore 가 대신 쓰인다. 그러면 renderer/bundle.js 처럼
//     실행에 꼭 필요한 산출물이 빠지고, docs/*.png 같은 스크린샷이 실린다.
//
// 결과물에 무엇이 들어가는지는 아래 COPY 목록이 전부다.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'dist-npm');
const p = (...xs) => path.join(ROOT, ...xs);

// 패키지에 실리는 파일 전부. 여기 없는 건 배포되지 않는다.
const COPY = [
  'out/main.js',            // 메인 프로세스 (빌드 산출물)
  'out/preload.js',
  'renderer/index.html',
  'renderer/style.css',
  'renderer/bundle.js',     // 렌더러 번들 — index.html 이 이걸 읽는다
  'bin/schema-lens.js',     // npx 진입점
  'build/icon.png',         // Dock 아이콘 (npm 설치본은 번들 아이콘이 없다)
  'assets/example.dbml',
  'README.md',
  'LICENSE',
];

const pkg = JSON.parse(fs.readFileSync(p('package.json'), 'utf8'));

// ── 1. 빌드 ──
console.log('빌드 중…');
execFileSync('node', [p('scripts/build.mjs')], { stdio: 'inherit', cwd: ROOT });

// ── 2. 스테이징 디렉터리 ──
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const missing = COPY.filter((f) => !fs.existsSync(p(f)));
if (missing.length) {
  console.error('빌드했는데도 없는 파일이 있습니다:\n  ' + missing.join('\n  '));
  process.exit(1);
}
for (const f of COPY) {
  const dst = path.join(OUT, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(p(f), dst);
}

// ── 3. 배포용 package.json ──
// electron 은 루트에서 devDependency 지만(electron-builder 요구) 여기서는 dependency 다.
const electronVersion = pkg.devDependencies.electron;
if (!electronVersion) {
  console.error('devDependencies 에 electron 이 없습니다. 루트 package.json 을 확인해 주세요.');
  process.exit(1);
}

const out = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  keywords: ['dbml', 'erd', 'schema', 'database', 'diagram', 'electron'],
  homepage: 'https://github.com/HwangBBang/schema-lens#readme',
  bugs: 'https://github.com/HwangBBang/schema-lens/issues',
  repository: pkg.repository,
  license: pkg.license,
  author: pkg.author,
  type: pkg.type,
  main: 'out/main.js',
  bin: { 'schema-lens': 'bin/schema-lens.js' },
  engines: { node: '>=20' },
  dependencies: { ...pkg.dependencies, electron: electronVersion },
};
fs.writeFileSync(path.join(OUT, 'package.json'), JSON.stringify(out, null, 2) + '\n');
fs.chmodSync(path.join(OUT, 'bin/schema-lens.js'), 0o755);

// ── 4. 요약 ──
const total = COPY.reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`\ndist-npm/ 조립 완료 — ${COPY.length + 1}개 파일, ${(total / 1048576).toFixed(2)}MB`);
console.log(`  ${out.name}@${out.version}  bin: schema-lens`);
console.log(`  dependencies: ${Object.entries(out.dependencies).map(([k, v]) => `${k}@${v}`).join(', ')}`);
console.log('\n확인:  npm pack --dry-run --prefix dist-npm');
console.log('배포:  npm publish dist-npm');
