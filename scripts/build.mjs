// 빌드: TypeScript 소스 → 실행 가능한 JavaScript.
//
// esbuild는 타입을 보지 않는다(그래서 빠르다). 타입 검사는 `npm run typecheck`가 따로 한다.
//
// 세 갈래로 나뉜다:
//  1) 렌더러 — file:// 에서 열리는 페이지라 브라우저가 import를 막는다(출처가 null이라 CORS).
//     한 덩어리로 묶어 <script> 하나로 읽힌다. elkjs는 이미 배포용으로 묶인 파일이라 다시
//     묶지 않고 그대로 <script>로 둔다(내부 워커 처리 방식을 건드리지 않으려고).
//  2) main/preload — Electron이 CommonJS로 읽는다. electron과 @dbml/core는 런타임 의존이라
//     번들에 넣지 않고 그대로 둔다(패키징 때 node_modules로 실린다).
//  3) 검증 스크립트 — out/scripts/ 로 나가고, 저장소 루트는 거기서 두 단계 위다.
//
// 실행: npm run build (start / test / pack이 먼저 부른다)

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const p = (...xs) => path.join(root, ...xs);

const common = { bundle: true, sourcemap: true, logLevel: 'info' };
const node = {
  ...common,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', '@dbml/core'],
};

await Promise.all([
  build({
    ...common,
    entryPoints: [p('renderer/app.ts')],
    outfile: p('renderer/bundle.js'),
    format: 'iife',
    platform: 'browser',
    target: 'chrome130', // Electron 43이 싣는 Chromium 기준
  }),
  build({ ...node, entryPoints: [p('main.ts'), p('preload.ts')], outdir: p('out') }),
  build({
    ...node,
    entryPoints: [p('scripts/check-model.ts'), p('scripts/check-contrast.ts')],
    outdir: p('out/scripts'),
  }),
]);

console.log('build: renderer/bundle.js, out/main.js, out/preload.js, out/scripts/*.js');
