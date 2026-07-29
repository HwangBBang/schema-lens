#!/usr/bin/env node
// npm 설치본의 진입점. `npx schema-lens schema.dbml` 이 여기로 들어온다.
//
// npm 으로 받으면 실행 파일이 아니라 소스만 깔린다. Electron 은 의존성으로 함께 설치되므로
// 그 바이너리를 찾아 이 패키지 디렉터리를 앱으로 지정해 띄운다.
//
// main.ts 의 argv 파싱이 `electron <appDir> [args...]` 형태(= app.isPackaged false, slice(2))를
// 전제하므로 인자를 그대로 이어 붙이면 된다.

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const APP_DIR = path.dirname(__dirname); // bin/ 의 부모 = 패키지 루트

let electronPath;
try {
  // node 에서 require 하면 Electron 실행 파일의 절대 경로 문자열이 나온다
  electronPath = require('electron');
} catch (e) {
  console.error('Electron을 찾지 못했습니다. 설치가 끝나지 않았을 수 있습니다.');
  console.error('npm install 을 --ignore-scripts 로 하셨다면 Electron 바이너리가 내려받아지지');
  console.error('않습니다. `npm rebuild electron` 을 실행하거나 --ignore-scripts 없이 다시 설치해 주세요.');
  process.exit(1);
}

if (typeof electronPath !== 'string') {
  console.error('Electron 바이너리 경로를 읽지 못했습니다. `npm rebuild electron` 을 실행해 주세요.');
  process.exit(1);
}

const child = spawn(electronPath, [APP_DIR, ...process.argv.slice(2)], { stdio: 'inherit' });

// Ctrl+C 로 껍데기만 죽고 창이 남는 일이 없도록 신호를 넘긴다
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { if (!child.killed) child.kill(sig); });
}

child.on('error', (err) => {
  console.error('Electron 실행에 실패했습니다:', err.message);
  process.exit(1);
});
child.on('close', (code, signal) => {
  // 신호로 죽은 경우 셸 관례대로 128 + signum 을 흉내낸다
  process.exit(signal ? 1 : (code ?? 0));
});
