// 렌더러 번들 빌드.
//
// 렌더러는 file:// 에서 열리는 페이지라 브라우저가 import를 막는다(출처가 null이라 CORS에 걸린다).
// 그래서 한 덩어리로 묶어 <script> 하나로 읽힌다. elkjs는 이미 배포용으로 묶인 파일이라
// 다시 묶지 않고 그대로 <script>로 두었다 — 내부 워커 처리 방식을 건드리지 않기 위해서다.
//
// 실행: npm run build (npm start / npm test가 먼저 부른다)

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const watch = process.argv.includes('--watch');

const result = await build({
  entryPoints: [path.join(root, 'renderer/app.js')],
  outfile: path.join(root, 'renderer/bundle.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome130', // Electron 43이 싣는 Chromium 기준
  sourcemap: true,
  logLevel: 'info',
});

if (result.errors.length) process.exit(1);
if (!watch) console.log('bundle: renderer/bundle.js');
