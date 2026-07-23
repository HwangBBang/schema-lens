const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { parseDbmlFile } = require('./src/parse');

// CLI: electron . [file.dbml] [--screenshot out.png] [--focus table] [--theme light|dark] [--side open|closed] [--layout group|lr|tb|grid] [--peek table] [--impact]
const argv = process.argv.slice(app.isPackaged ? 1 : 2);
const cli = { file: null, screenshot: null, focus: null, theme: null, side: null, layout: null, peek: null, impact: false };
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--screenshot') cli.screenshot = argv[++i];
  else if (argv[i] === '--focus') cli.focus = argv[++i];
  else if (argv[i] === '--theme') cli.theme = argv[++i];
  else if (argv[i] === '--side') cli.side = argv[++i];
  else if (argv[i] === '--layout') cli.layout = argv[++i];
  else if (argv[i] === '--peek') cli.peek = argv[++i];
  else if (argv[i] === '--impact') cli.impact = true;
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

function sendModel(filePath) {
  if (!win) return;
  try {
    const model = parseDbmlFile(filePath);
    currentFile = filePath;
    rememberFile(filePath);
    watchFile(filePath);
    win.webContents.send('model', { model, path: filePath, focus: cli.focus, theme: cli.theme, side: cli.side, layout: cli.layout, peek: cli.peek, impact: cli.impact, error: null });
    cli.focus = null; cli.theme = null; cli.side = null; cli.layout = null; cli.peek = null; cli.impact = false; // 최초 1회만 적용 — 재파싱마다 리셋되지 않게
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
