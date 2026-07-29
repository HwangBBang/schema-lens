import { app, BrowserWindow, Menu, dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { importer } from '@dbml/core';
import { parseDbml, parseDbmlFile } from './src/parse.ts';
import { gitBaseline, isFailure } from './src/git-baseline.ts';

// CLI: electron . [file.dbml] [--screenshot out.png] [--focus table] [--theme light|dark] [--side open|closed] [--layout group|lr|tb|grid] [--peek table] [--impact] [--view library|extract] [--diff] [--cols keys|all]
const argv = process.argv.slice(app.isPackaged ? 1 : 2);

type Cli = {
  file: string | null;
  screenshot: string | null;
  focus: string | null;
  theme: string | null;
  side: string | null;
  layout: string | null;
  peek: string | null;
  impact: boolean;
  view: string | null;
  diff: boolean;
  cols: string | null;
};

/** 라이브러리 카드 한 장 — userData/library.json에 그대로 저장된다 */
type LibEntry = {
  name: string;
  path: string;
  addedAt: string;
  lastOpenedAt?: string;
  stats?: { tables: number; refs: number };
};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const cli: Cli = { file: null, screenshot: null, focus: null, theme: null, side: null, layout: null, peek: null, impact: false, view: null, diff: false, cols: null };
for (let i = 0; i < argv.length; i++) {
  const next = (): string | null => argv[++i] ?? null;
  if (argv[i] === '--screenshot') cli.screenshot = next();
  else if (argv[i] === '--focus') cli.focus = next();
  else if (argv[i] === '--theme') cli.theme = next();
  else if (argv[i] === '--side') cli.side = next();
  else if (argv[i] === '--layout') cli.layout = next();
  else if (argv[i] === '--peek') cli.peek = next();
  else if (argv[i] === '--impact') cli.impact = true;
  else if (argv[i] === '--view') cli.view = next();
  else if (argv[i] === '--diff') cli.diff = true;
  else if (argv[i] === '--cols') cli.cols = next();
  else if (!argv[i]?.startsWith('-')) cli.file = argv[i] ?? null;
}
// --peek/--impact는 명시적 --focus 필수 — 역산 금지, 즉시 실패 (검증 스크린샷의 결정성)
if ((cli.peek || cli.impact) && !cli.focus) {
  console.error('--peek/--impact requires an explicit --focus <table>');
  process.exit(1);
}

let win: BrowserWindow | null = null;
let currentFile: string | null = null;
let watcher: fs.FSWatcher | null = null;

const lastFileStore = () => path.join(app.getPath('userData'), 'last-file.json');
function rememberFile(p: string): void {
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
function libLoad(): LibEntry[] {
  try { const l = JSON.parse(fs.readFileSync(libStore(), 'utf8')); return Array.isArray(l) ? l : []; } catch { return []; }
}
function libSave(list: LibEntry[]): void {
  try { fs.writeFileSync(libStore(), JSON.stringify(list, null, 2)); } catch {}
}
function libTouch(filePath: string, stats?: { tables: number; refs: number }): void {
  const list = libLoad();
  let e = list.find((x) => x.path === filePath);
  const now = new Date().toISOString();
  if (!e) { e = { name: path.basename(filePath), path: filePath, addedAt: now }; list.push(e); }
  e.name = path.basename(filePath);
  e.lastOpenedAt = now;
  if (stats) e.stats = stats;
  libSave(list);
}

function sendModel(filePath: string): void {
  if (!win) return;
  try {
    const model = parseDbmlFile(filePath);
    currentFile = filePath;
    rememberFile(filePath);
    libTouch(filePath, { tables: model.tables.length, refs: model.refs.length });
    watchFile(filePath);
    win.webContents.send('model', { model, path: filePath, focus: cli.focus, theme: cli.theme, side: cli.side, layout: cli.layout, peek: cli.peek, impact: cli.impact, cols: cli.cols, diff: cli.diff, error: null });
    cli.focus = null; cli.theme = null; cli.side = null; cli.layout = null; cli.peek = null; cli.impact = false; cli.diff = false; cli.cols = null; // 최초 1회만 적용 — 재파싱마다 리셋되지 않게
    win.setTitle(`schema-lens — ${path.basename(filePath)}`);
    app.addRecentDocument(filePath);
  } catch (e) {
    win.webContents.send('model', { model: null, path: filePath, focus: null, theme: cli.theme, side: cli.side, error: errText(e) });
  }
}

// 파일이 아닌 부모 디렉토리를 감시 — 삭제 후 재생성(git checkout 등)돼도 계속 동작
function watchFile(filePath: string): void {
  if (watcher) { watcher.close(); watcher = null; }
  try {
    let t: NodeJS.Timeout | null = null;
    const base = path.basename(filePath);
    watcher = fs.watch(path.dirname(filePath), (_ev, fname) => {
      if (fname && fname !== base) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => { if (fs.existsSync(filePath)) sendModel(filePath); }, 200);
    });
  } catch {}
}

async function openDialog(): Promise<void> {
  if (!win) return;
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
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html')); // out/ 에서 실행된다
  win.webContents.on('did-finish-load', () => {
    const f = currentFile || (cli.file ? path.resolve(cli.file) : recallFile());
    cli.file = null; // 이후 리로드/재생성 시 현재 파일 우선
    if (f) sendModel(f);
    if (win && (cli.view === 'library' || cli.view === 'extract')) { // 스크린샷 검증용 세션 한정 오버라이드
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
    return { dbml: importer.import(String(sql || ''), dialect === 'mysql' ? 'mysql' : 'postgres') };
  } catch (err) {
    return { error: errText(err) };
  }
});
ipcMain.handle('extract-save', async (_e, dbml: string) => {
  if (!win) return { canceled: true };
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
    return { error: errText(err) };
  }
});
// 렌더러는 DBML을 파싱할 수 없다(파서가 Node 전용) — 기준본은 여기서 모델까지 만들어 넘긴다
ipcMain.handle('git-baseline', async () => {
  const r = await gitBaseline(currentFile);
  if (isFailure(r)) return r;
  try {
    return { model: parseDbml(r.text), sha: r.sha, subject: r.subject, when: r.when };
  } catch (e) {
    return { error: 'parse', message: `기준본을 읽었지만 파싱에 실패했습니다 — ${errText(e)}` };
  }
});
ipcMain.handle('open-sql-dialog', async () => {
  if (!win) return null;
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
    console.error('screenshot failed:', errText(e));
    app.exit(1);
  }
});

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open DBML…', accelerator: 'CmdOrCtrl+O', click: () => openDialog() },
        { label: 'Reload File', accelerator: 'CmdOrCtrl+R', click: () => { if (currentFile) sendModel(currentFile); } },
        { type: 'separator' },
        { label: '스키마 라이브러리', accelerator: 'CmdOrCtrl+L', click: () => win && win.webContents.send('show-view', 'library') },
        { label: 'SQL에서 DBML 추출…', accelerator: 'CmdOrCtrl+Shift+E', click: () => win && win.webContents.send('show-view', 'extract') },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? ('close' as const) : ('quit' as const) },
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
    { role: 'editMenu' as const }, { role: 'windowMenu' as const },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 패키징된 앱은 번들이 제 아이콘을 들고 있지만, 소스 실행과 npm 설치본은 Electron 기본 번들로
// 뜨기 때문에 Dock에 Electron 원자 아이콘이 나온다. 그 경우에만 우리 아이콘을 얹는다.
// (메뉴바 왼쪽 위의 굵은 이름은 번들 Info.plist 에서 오는 값이라 여기서 못 바꾼다)
function setDevDockIcon() {
  if (process.platform !== 'darwin' || app.isPackaged || !app.dock) return;
  const icon = path.join(__dirname, '..', 'build', 'icon.png');
  if (fs.existsSync(icon)) app.dock.setIcon(icon);
}

app.whenReady().then(() => {
  setDevDockIcon();
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('open-file', (e, p) => { e.preventDefault(); if (win) sendModel(p); else cli.file = p; });
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || cli.screenshot) app.quit(); });
