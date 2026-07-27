const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { parseDbml, parseDbmlFile } = require('./src/parse');
const { gitBaseline } = require('./src/git-baseline');

// CLI: electron . [file.dbml] [--screenshot out.png] [--focus table] [--theme light|dark] [--side open|closed] [--layout group|lr|tb|grid] [--peek table] [--impact] [--view library|extract] [--diff]
const argv = process.argv.slice(app.isPackaged ? 1 : 2);
const cli = { file: null, screenshot: null, focus: null, theme: null, side: null, layout: null, peek: null, impact: false, view: null, diff: false };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--screenshot') cli.screenshot = argv[++i];
  else if (argv[i] === '--focus') cli.focus = argv[++i];
  else if (argv[i] === '--theme') cli.theme = argv[++i];
  else if (argv[i] === '--side') cli.side = argv[++i];
  else if (argv[i] === '--layout') cli.layout = argv[++i];
  else if (argv[i] === '--peek') cli.peek = argv[++i];
  else if (argv[i] === '--impact') cli.impact = true;
  else if (argv[i] === '--view') cli.view = argv[++i];
  else if (argv[i] === '--diff') cli.diff = true;
  else if (!argv[i].startsWith('-')) cli.file = argv[i];
}
// --peek/--impact는 명시적 --focus 필수 — 역산 금지, 즉시 실패 (검증 스크린샷의 결정성)
if ((cli.peek || cli.impact) && !cli.focus) {
  console.error('--peek/--impact requires an explicit --focus <table>');
  process.exit(1);
}

let win = null;
let currentFile = null;
let watcher = null;

const lastFileStore = () => path.join(app.getPath('userData'), 'last-file.json');
function rememberFile(p) {
  try { fs.writeFileSync(lastFileStore(), JSON.stringify({ file: p })); } catch {}
}
function recallFile() {
  try {
    const p = JSON.parse(fs.readFileSync(lastFileStore(), 'utf8')).file;
    return p && fs.existsSync(p) ? p : null;
  } catch { return null; }
}

// ── 스키마 라이브러리: 등록된 .dbml 파일 목록 + 메타 캐시 (SSOT는 파일 자체) ──
const libStore = () => path.join(app.getPath('userData'), 'library.json');
function libLoad() {
  try { const l = JSON.parse(fs.readFileSync(libStore(), 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; }
}
function libSave(list) {
  try { fs.writeFileSync(libStore(), JSON.stringify(list, null, 2)); } catch {}
}
function libTouch(filePath, stats) {
  const list = libLoad();
  let e = list.find((x) => x.path === filePath);
  const now = new Date().toISOString();
  if (!e) { e = { name: path.basename(filePath), path: filePath, addedAt: now }; list.push(e); }
  e.name = path.basename(filePath);
  e.lastOpenedAt = now;
  if (stats) e.stats = stats;
  libSave(list);
}

function sendModel(filePath) {
  if (!win) return;
  try {
    const model = parseDbmlFile(filePath);
    currentFile = filePath;
    rememberFile(filePath);
    libTouch(filePath, { tables: model.tables.length, refs: model.refs.length });
    watchFile(filePath);
    win.webContents.send('model', { model, path: filePath, focus: cli.focus, theme: cli.theme, side: cli.side, layout: cli.layout, peek: cli.peek, impact: cli.impact, diff: cli.diff, error: null });
    cli.focus = null; cli.theme = null; cli.side = null; cli.layout = null; cli.peek = null; cli.impact = false; cli.diff = false; // 최초 1회만 적용 — 재파싱마다 리셋되지 않게
    win.setTitle(`schema-lens — ${path.basename(filePath)}`);
    app.addRecentDocument(filePath);
  } catch (e) {
    win.webContents.send('model', { model: null, path: filePath, focus: null, theme: cli.theme, side: cli.side, error: String(e.message || e) });
  }
}

// 파일이 아닌 부모 디렉토리를 감시 — 삭제 후 재생성(git checkout 등)돼도 계속 동작
function watchFile(filePath) {
  if (watcher) { watcher.close(); watcher = null; }
  try {
    let t = null;
    const base = path.basename(filePath);
    watcher = fs.watch(path.dirname(filePath), (_ev, fname) => {
      if (fname && fname !== base) return;
      clearTimeout(t);
      t = setTimeout(() => { if (fs.existsSync(filePath)) sendModel(filePath); }, 200);
    });
  } catch {}
}

async function openDialog() {
  const r = await dialog.showOpenDialog(win, {
    filters: [{ name: 'DBML', extensions: ['dbml', 'txt'] }, { name: 'All', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (!r.canceled && r.filePaths[0]) sendModel(r.filePaths[0]);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1560, height: 1000,
    show: true,
    backgroundColor: cli.theme === 'dark' ? '#111113' : '#ebebeb', // 라이트가 기본
    // 타이틀바 제거 — 신호등을 사이드바 상단에 인셋 (GPT 데스크톱앱 방식, macOS 한정)
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 16 } }
      : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('renderer/index.html');
  win.webContents.on('did-finish-load', () => {
    const f = currentFile || (cli.file ? path.resolve(cli.file) : recallFile());
    cli.file = null; // 이후 리로드/재생성 시 현재 파일 우선
    if (f) sendModel(f);
    if (cli.view === 'library' || cli.view === 'extract') { // 스크린샷 검증용 세션 한정 오버라이드
      win.webContents.send('show-view', cli.view);
      cli.view = null;
    }
  });
  win.on('closed', () => { win = null; });
  if (cli.screenshot) {
    // 렌더 실패/행업이어도 자동화가 멈추지 않도록 상한
    setTimeout(() => {
      console.error('screenshot timeout (20s) — render-done not received');
      app.exit(1);
    }, 20000).unref?.();
  }
}

ipcMain.handle('open-file-dialog', () => openDialog());
ipcMain.on('open-path', (_e, p) => { if (p && fs.existsSync(p)) sendModel(p); });

// ── 라이브러리 / SQL→DBML 추출 IPC ──
ipcMain.handle('library-list', () =>
  libLoad()
    .map((e) => ({ ...e, missing: !fs.existsSync(e.path) }))
    .sort((a, b) => String(b.lastOpenedAt || '').localeCompare(String(a.lastOpenedAt || ''))));
ipcMain.handle('library-remove', (_e, p) => { libSave(libLoad().filter((x) => x.path !== p)); return true; });
ipcMain.handle('extract-convert', (_e, { sql, dialect }) => {
  try {
    const { importer } = require('@dbml/core');
    return { dbml: importer.import(String(sql || ''), dialect === 'mysql' ? 'mysql' : 'postgres') };
  } catch (err) {
    return { error: String(err.message || err) };
  }
});
ipcMain.handle('extract-save', async (_e, dbml) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: 'schema.dbml',
    filters: [{ name: 'DBML', extensions: ['dbml'] }],
  });
  if (r.canceled || !r.filePath) return { canceled: true };
  try {
    fs.writeFileSync(r.filePath, dbml);
    sendModel(r.filePath); // 저장 즉시 라이브러리 등록 + 렌더
    return { path: r.filePath };
  } catch (err) {
    return { error: String(err.message || err) };
  }
});
// 렌더러는 DBML을 파싱할 수 없다(파서가 Node 전용) — 기준본은 여기서 모델까지 만들어 넘긴다
ipcMain.handle('git-baseline', async () => {
  const r = await gitBaseline(currentFile);
  if (r.error) return r;
  try {
    return { model: parseDbml(r.text), sha: r.sha, subject: r.subject, when: r.when };
  } catch (e) {
    return { error: 'parse', message: `기준본을 읽었지만 파싱에 실패했습니다 — ${e.message}` };
  }
});
ipcMain.handle('open-sql-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    filters: [{ name: 'SQL', extensions: ['sql', 'ddl', 'txt'] }, { name: 'All', extensions: ['*'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  try { return fs.readFileSync(r.filePaths[0], 'utf8'); } catch { return null; }
});
ipcMain.on('render-done', async (_e, info) => {
  if (!cli.screenshot || !win) return;
  try {
    await new Promise((r) => setTimeout(r, 500));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.resolve(cli.screenshot), img.toPNG());
    console.log('screenshot saved:', path.resolve(cli.screenshot));
    app.exit(info && info.error ? 2 : 0); // 에러 화면 캡처는 비정상 코드로 구분
  } catch (e) {
    console.error('screenshot failed:', e.message || e);
    app.exit(1);
  }
});

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open DBML…', accelerator: 'CmdOrCtrl+O', click: () => openDialog() },
        { label: 'Reload File', accelerator: 'CmdOrCtrl+R', click: () => { if (currentFile) sendModel(currentFile); } },
        { type: 'separator' },
        { label: '스키마 라이브러리', accelerator: 'CmdOrCtrl+L', click: () => win && win.webContents.send('show-view', 'library') },
        { label: 'SQL에서 DBML 추출…', accelerator: 'CmdOrCtrl+Shift+E', click: () => win && win.webContents.send('show-view', 'extract') },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reset Layout', accelerator: 'CmdOrCtrl+Shift+R', click: () => win && win.webContents.send('reset-layout') },
        { type: 'separator' },
        { role: 'toggleDevTools' }, { role: 'togglefullscreen' },
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
      ],
    },
    { role: 'editMenu' }, { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('open-file', (e, p) => { e.preventDefault(); if (win) sendModel(p); else cli.file = p; });
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || cli.screenshot) app.quit(); });
