// 앱 셸: 상태, 사이드바, 툴바, 모드 전환(ERD/포커스), IPC, 드래그앤드롭.
//
// 번들 진입점이다. 아래 import 순서 = 예전 index.html의 <script> 순서이고, 그 순서대로 평가된다.
// 각 파일은 아직 전역(window.ERD 등)으로 서로를 찾는다 — 렌더러를 TypeScript로 옮길 때 정리한다.
import * as Semantics from '../src/semantics.ts';
import { ERD } from './erd.ts';
import { Focus } from './focus.ts';
import { Compare } from './compare.ts';
import type { Table } from '../src/model.ts';
import type { AppState, ColsMode, Filter, Mode, ModelPayload } from './types.ts';

// 이벤트 대상은 Element일 때만 의미가 있다 — 좁혀서 쓴다
const asEl = (t: EventTarget | null): Element | null => (t instanceof Element ? t : null);

(() => {
  // 기본 테마는 라이트. 사용자가 토글하면 localStorage로 유지, CLI --theme은 세션 한정 오버라이드.
  document.documentElement.setAttribute('data-theme',
    document.documentElement.getAttribute('data-theme') || localStorage.getItem('dbv-theme') || 'light');
  // macOS는 타이틀바 없이 신호등이 사이드바 상단에 겹침 — 여백·드래그 영역 활성화
  if (navigator.platform.startsWith('Mac')) document.body.classList.add('titlebar-hidden');
  // 마크업에 없는 id를 찾으면 조용히 null을 흘리지 않고 바로 터뜨린다 — 원인이 먼 곳에서 드러나는 걸 막는다
  const $ = (id: string): HTMLElement => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`요소를 찾을 수 없습니다: #${id}`);
    return el;
  };
  const $btn = (id: string): HTMLButtonElement => $(id) as HTMLButtonElement;
  const $input = (id: string): HTMLInputElement => $(id) as HTMLInputElement;
  const esc = (s: unknown): string => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const S: AppState = {
    model: null, sem: null, filePath: null,
    mode: 'erd', focusTable: null, lastFocus: null, hist: [],
    filter: 'all', colsMode: 'keys',
    hubShown: {}, selected: null,
    groupColor: {},
    impact: false, // 삭제 영향 모드 — go() 이동에도 유지, 파일 교체 시 리셋
  };
  let firstRenderDone = false;
  const tableExists = (n: string | null): boolean => !!n && !!S.model && S.model.tables.some((t) => t.name === n);

  // ── 툴팁 ──
  const ttEl = $('tooltip');
  const tooltip = {
    show(html: string, x: number, y: number): void { ttEl.innerHTML = html; ttEl.style.display = 'block'; tooltip.move(x, y); },
    move(x: number, y: number): void {
      const r = ttEl.getBoundingClientRect();
      ttEl.style.left = Math.min(x + 14, innerWidth - r.width - 8) + 'px';
      ttEl.style.top = Math.min(y + 16, innerHeight - r.height - 8) + 'px';
    },
    hide() { ttEl.style.display = 'none'; },
  };

  // ── 모드 전환 ── (포커스 렌더 완료를 promise로 전파 — CLI 캡처 계약)
  async function setMode(mode: Mode): Promise<void> {
    const prev = S.mode;
    S.mode = mode;
    $('erdwrap').style.display = mode === 'erd' ? 'block' : 'none';
    $('focuswrap').style.display = mode === 'focus' ? 'block' : 'none';
    $('cmpwrap').style.display = mode === 'diff' ? 'flex' : 'none';
    $('m-erd').setAttribute('aria-pressed', String(mode === 'erd'));
    $('m-focus').setAttribute('aria-pressed', String(mode === 'focus'));
    $('m-diff').setAttribute('aria-pressed', String(mode === 'diff'));
    $('crumb').hidden = mode !== 'focus';
    if (mode === 'focus') {
      if (!S.focusTable) S.focusTable = defaultFocusTable();
      if (S.focusTable) await Focus.render(S.focusTable); // 테이블이 하나도 없으면 그릴 게 없다
      S.lastFocus = S.focusTable;
      syncCrumb();
    } else if (mode === 'diff') {
      await Compare.render(); // 기준본을 못 읽으면 화면 안에서 이유를 보여주고 끝난다
    } else {
      ERD.fitIfPending(); // 포커스 모드 중 미뤄둔 fit 실행
      // 포커스에서 복귀하면 보던 테이블을 ERD에서도 선택·센터링 — 왕복 컨텍스트 유지
      if (prev === 'focus' && tableExists(S.focusTable)) {
        S.selected = S.focusTable;
        ERD.select(S.selected);
        ERD.centerOn(S.selected);
      }
    }
    syncSidebarActive();
  }
  function defaultFocusTable(): string | null {
    // 차수(degree) 최대 테이블로 시작
    let best: string | null = null, bd = -1;
    for (const t of S.model?.tables ?? []) {
      const d = S.sem?.tableMeta[t.name]?.degree ?? 0;
      if (d > bd) { bd = d; best = t.name; }
    }
    return best;
  }
  function go(name: string, fromHist?: boolean): void {
    // 히스토리에는 실제로 렌더된 적 있는 포커스(lastFocus)만 쌓는다
    if (S.mode !== 'focus') {
      if (S.lastFocus && S.lastFocus !== name && !fromHist) { S.hist.push(S.lastFocus); $btn('back').disabled = false; }
      S.focusTable = name;
      setMode('focus');
      return;
    }
    if (name === S.focusTable && !fromHist) return;
    if (S.lastFocus && !fromHist) { S.hist.push(S.lastFocus); $btn('back').disabled = false; }
    S.focusTable = name;
    Focus.render(name);
    S.lastFocus = name;
    syncCrumb(); syncSidebarActive();
  }
  // 크럼 수치는 포커스 카드 하단과 같은 기준(고유 테이블 수, 필터 반영)
  function syncCrumb() {
    // 탐색 경로: 히스토리 꼬리 3개를 클릭 가능한 브레드크럼으로
    const tail = S.hist.slice(-3);
    $('crumb-path').innerHTML = (S.hist.length > 3 ? '<span>…</span>' : '') +
      tail.map((h, i) => `<a data-idx="${S.hist.length - tail.length + i}">${esc(h)}</a><span>›</span>`).join('');
    $('crumb-now').textContent = S.focusTable || '—';
    const cs = new Set(), ps = new Set();
    for (const r of S.model?.refs ?? []) {
      if (S.filter === 'real' && r.kind === 'logical') continue;
      if (r.self) continue;
      if (r.parent.table === S.focusTable) cs.add(r.child.table);
      if (r.child.table === S.focusTable) ps.add(r.parent.table);
    }
    $('crumb-deg').textContent = `피참조 ${cs.size} · 참조 ${ps.size}`;
  }

  // ── 사이드바 ──
  const grpStoreLoad = (): Record<string, boolean> => { try { return JSON.parse(localStorage.getItem('dbv-grps') || '{}') as Record<string, boolean>; } catch { return {}; } };
  const grpStoreSave = (m: Record<string, boolean>): void => { try { localStorage.setItem('dbv-grps', JSON.stringify(m)); } catch {} };
  function buildSidebar() {
    const list = $('list');
    list.innerHTML = '';
    const collapsed = grpStoreLoad();
    const grouped = new Set();
    const addItem = (box: HTMLElement, t: Table, gv: string): void => {
      const it = document.createElement('div');
      it.className = 'item'; it.dataset.name = t.name; it.tabIndex = 0;
      it.setAttribute('role', 'button');
      it.style.setProperty('--gc', `var(${gv})`);
      const d = S.sem?.tableMeta[t.name]?.degree ?? 0;
      it.innerHTML = `<i class="dot"></i><span class="nm">${esc(t.name)}</span><span class="deg">${d}</span>`;
      const act = () => {
        if (S.mode === 'erd') { S.selected = t.name; ERD.select(t.name); ERD.centerOn(t.name); }
        else go(t.name);
        syncSidebarActive();
      };
      it.addEventListener('click', act);
      it.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } });
      box.appendChild(it);
    };
    // 그룹 = 접을 수 있는 섹션 (상태는 그룹명 기준 localStorage 유지)
    const addSection = (gname: string, gv: string, members: Table[]): void => {
      const lab = document.createElement('button');
      lab.className = 'grp-lab'; lab.style.setProperty('--gc', `var(${gv})`);
      lab.setAttribute('aria-expanded', String(!collapsed[gname]));
      lab.innerHTML = `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg>` +
        `<i></i><span class="gn">${esc(gname)}</span><span class="gcnt">${members.length}</span>`;
      const box = document.createElement('div');
      box.className = 'grp-items' + (collapsed[gname] ? ' collapsed' : '');
      members.forEach((t: Table) => addItem(box, t, gv));
      lab.addEventListener('click', () => {
        const m = grpStoreLoad();
        m[gname] = !box.classList.contains('collapsed');
        if (!m[gname]) delete m[gname];
        grpStoreSave(m);
        box.classList.toggle('collapsed', !!m[gname]);
        lab.setAttribute('aria-expanded', String(!m[gname]));
      });
      list.appendChild(lab);
      list.appendChild(box);
    };
    for (const g of S.model?.groups ?? []) {
      const members = (S.model?.tables ?? []).filter((t) => t.group === g.name);
      if (!members.length) continue;
      members.forEach((t) => grouped.add(t.name));
      addSection(g.name, S.groupColor[g.name] ?? '--gc-x', members);
    }
    const rest = (S.model?.tables ?? []).filter((t) => !grouped.has(t.name));
    if (rest.length) addSection('ungrouped', '--gc-x', rest);
  }
  function syncSidebarActive() {
    const active = S.mode === 'erd' ? S.selected : S.focusTable;
    $('list').querySelectorAll<HTMLElement>('.item').forEach((i) => i.classList.toggle('active', i.dataset['name'] === active));
    const a = $('list').querySelector('.item.active');
    if (a) {
      // 활성 항목이 접힌 그룹 안이면 펼쳐서 보이게
      const box = a.closest('.grp-items');
      const lab = box?.previousElementSibling;
      if (box?.classList.contains('collapsed') && lab instanceof HTMLElement) lab.click();
      a.scrollIntoView({ block: 'nearest' });
    }
  }

  // ── 스키마 라이브러리 / SQL 추출 뷰 ──
  const xSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  async function refreshLibrary() {
    const list = await window.dbv.libraryList();
    const grid = $('lib-grid');
    grid.innerHTML = '';
    $('lib-empty').hidden = list.length > 0;
    for (const e of list) {
      const c = document.createElement('div');
      c.className = 'lib-card' + (e.missing ? ' missing' : '');
      c.setAttribute('role', 'button'); c.tabIndex = 0; c.title = e.path;
      const st = e.stats ? `${e.stats.tables} tables · ${e.stats.refs} refs` : '아직 열지 않음';
      const when = e.lastOpenedAt ? new Date(e.lastOpenedAt).toLocaleDateString('ko-KR') : '';
      c.innerHTML =
        `<span class="nm">${esc(e.name)}</span><span class="pth">${esc(e.path)}</span>` +
        `<span class="meta">${esc(st)}${e.missing ? ' · 파일 없음' : ''}${when ? ' · ' + esc(when) : ''}</span>` +
        `<span class="rm" role="button" tabindex="0" title="목록에서 제거 (파일은 지우지 않음)">${xSvg}</span>`;
      const open = () => { if (!e.missing) window.dbv.openPath(e.path); };
      c.addEventListener('click', open);
      c.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); open(); } });
      c.querySelector('.rm')?.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await window.dbv.libraryRemove(e.path);
        refreshLibrary();
      });
      grid.appendChild(c);
    }
  }
  function showWelcome(view: string): void {
    $('welcome').style.display = 'flex';
    $('lib-view').hidden = view === 'extract';
    $('ext-view').hidden = view !== 'extract';
    $('lib-close').hidden = !S.model;
    closeSchemaMenu();
    if (view !== 'extract') refreshLibrary();
  }
  function hideWelcome() { $('welcome').style.display = 'none'; }
  const welcomeVisible = () => $('welcome').style.display !== 'none';
  $('lib-extract').addEventListener('click', () => showWelcome('extract'));
  $('ext-back').addEventListener('click', () => showWelcome('library'));
  $('lib-close').addEventListener('click', hideWelcome);

  // SQL → DBML 추출
  let dialect = 'postgres';
  const setDialect = (d: string): void => {
    dialect = d;
    $('d-pg').setAttribute('aria-pressed', String(d === 'postgres'));
    $('d-my').setAttribute('aria-pressed', String(d === 'mysql'));
  };
  $('d-pg').addEventListener('click', () => setDialect('postgres'));
  $('d-my').addEventListener('click', () => setDialect('mysql'));
  $('ext-open-sql').addEventListener('click', async () => {
    const sql = await window.dbv.openSqlDialog();
    if (sql != null) $input('ext-sql').value = sql;
  });
  const extErr = (msg: string | null): void => {
    $('ext-err').hidden = !msg;
    $('ext-err').textContent = msg || '';
  };
  $('ext-convert').addEventListener('click', async () => {
    const sql = $input('ext-sql').value;
    if (!sql.trim()) { extErr('변환할 SQL을 입력하세요.'); return; }
    const r = await window.dbv.extractConvert(sql, dialect);
    if (r.error) { extErr(`변환 실패: ${r.error}`); $input('ext-dbml').value = ''; $btn('ext-save').disabled = true; return; }
    extErr(null);
    $input('ext-dbml').value = r.dbml ?? '';
    $btn('ext-save').disabled = !(r.dbml ?? '').trim();
  });
  $('ext-save').addEventListener('click', async () => {
    const r = await window.dbv.extractSave($input('ext-dbml').value);
    if (r && r.error) extErr(`저장 실패: ${r.error}`);
    // 성공 시 main이 sendModel → onModel이 라이브러리 갱신·화면 전환
  });

  // 사이드바 스키마 전환 드롭다운
  function closeSchemaMenu() { $('schema-menu').hidden = true; }
  async function openSchemaMenu() {
    const m = $('schema-menu');
    const list = await window.dbv.libraryList();
    m.innerHTML = '';
    for (const e of list.slice(0, 12)) {
      const b = document.createElement('button');
      b.className = 'smi' + (e.path === S.filePath ? ' cur' : '');
      b.disabled = !!e.missing;
      b.title = e.path;
      b.innerHTML = `<span class="nm">${esc(e.name)}</span>` +
        `<span class="meta">${e.stats ? esc(String(e.stats.tables)) + ' tables' : ''}</span>`;
      b.addEventListener('click', () => { closeSchemaMenu(); if (e.path !== S.filePath) window.dbv.openPath(e.path); });
      m.appendChild(b);
    }
    const lib = document.createElement('button');
    lib.className = 'smi lib-link';
    lib.textContent = '스키마 라이브러리 열기  ⌘L';
    lib.addEventListener('click', () => { closeSchemaMenu(); showWelcome('library'); });
    m.appendChild(lib);
    const sh = $('side-head');
    m.style.top = (sh.offsetTop + sh.offsetHeight + 4) + 'px';
    m.hidden = false;
  }
  $('side-head').addEventListener('click', () => {
    if ($('schema-menu').hidden) openSchemaMenu(); else closeSchemaMenu();
  });
  $('side-head').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('side-head').click(); }
  });
  document.addEventListener('click', (e) => {
    const t = asEl(e.target);
    if (!t?.closest('#schema-menu') && !t?.closest('#side-head')) closeSchemaMenu();
  });
  window.dbv.onShowView((v) => showWelcome(v));
  refreshLibrary(); // 시작 시 파일이 없으면 라이브러리가 첫 화면

  // ── 범례 ──
  function buildLegend() {
    $('tlegend').innerHTML = Object.values(S.sem?.TYPES ?? {})
      .map((t) => `<span class="tc" style="--c:var(${t.cssVar})">${t.label}</span>`).join('');
    const ht = $('hub-toggles');
    ht.innerHTML = '';
    if (!S.sem?.hubs.length) { ht.innerHTML = '<span style="color:var(--faint)">허브 없음</span>'; return; }
    for (const h of S.sem.hubs) {
      const lab = document.createElement('label');
      lab.className = 'hub-tg';
      lab.title = `${h.table}(으)로 들어오는 엣지 ${h.inDegree}개 — 기본 접힘(카드 하단 칩으로 표시)`;
      lab.innerHTML = `<input type="checkbox" ${S.hubShown[h.table] ? 'checked' : ''}> ${h.table} 엣지 <b>${h.inDegree}</b>`;
      lab.querySelector('input')?.addEventListener('change', (e) => {
        S.hubShown[h.table] = (e.target as HTMLInputElement).checked;
        ERD.applyHubToggles();
      });
      ht.appendChild(lab);
    }
  }

  // ── 모델 수신 ──
  async function onModel({ model, path, focus, theme, side, layout, peek, impact, cols, diff: wantDiff, error }: ModelPayload): Promise<void> {
    if (theme === 'light' || theme === 'dark')
      document.documentElement.setAttribute('data-theme', theme);
    if (side === 'open' || side === 'closed')
      applySide(side === 'open', false); // CLI 오버라이드 — 세션 한정, localStorage 미기록
    if (cols === 'keys' || cols === 'all') { // CLI --cols — 아래 ERD.load/비교 렌더가 이 값을 읽는다
      S.colsMode = cols;
      $('c-keys').setAttribute('aria-pressed', String(cols === 'keys'));
      $('c-all').setAttribute('aria-pressed', String(cols === 'all'));
    }
    if (error) {
      if (S.model && S.filePath === path) {
        // 편집 중 일시적 문법 오류 — 기존 다이어그램을 유지하고 배너만 표시
        $('errbar').hidden = false;
        $('errbar-msg').textContent = ` ${error}`;
      } else {
        showWelcome('library');
        $('welcome-err').hidden = false;
        $('welcome-err').textContent = `파싱 실패: ${path}\n\n${error}`;
      }
      if (!firstRenderDone) {
        firstRenderDone = true;
        requestAnimationFrame(() => requestAnimationFrame(() => window.dbv.renderDone({ error: true })));
      }
      return;
    }
    $('errbar').hidden = true;
    if (!model) return; // 오류 분기는 위에서 이미 처리됐다 — 여기 도달하면 모델이 있다
    const keepFile = S.filePath === path;
    S.model = model; S.filePath = path;
    S.sem = Semantics.analyze(model);
    S.groupColor = {};
    model.groups.forEach((g, i: number) => { S.groupColor[g.name] = '--gc-' + (i % 10); });
    if (!keepFile) {
      S.hubShown = {}; S.selected = null; S.hist = []; S.focusTable = null; S.lastFocus = null;
      S.impact = false;
      $btn('back').disabled = true;
      S.sem.hubs.forEach((h) => { S.hubShown[h.table] = false; });
    } else {
      // 재파싱으로 사라진 테이블에 대한 stale 상태 정리
      if (!tableExists(S.selected)) S.selected = null;
      if (!tableExists(S.focusTable)) { S.focusTable = null; S.lastFocus = null; }
      if (!tableExists(S.lastFocus)) S.lastFocus = null;
      S.hist = S.hist.filter(tableExists);
      $btn('back').disabled = !S.hist.length;
      const hs: Record<string, boolean> = {};
      S.sem?.hubs.forEach((h) => { hs[h.table] = !!S.hubShown[h.table]; });
      S.hubShown = hs;
    }
    if (focus) {
      if (model.tables.some((t: Table) => t.name === focus)) { S.focusTable = focus; S.mode = 'focus'; }
      else console.warn(`--focus ${focus}: 테이블이 없어 무시`);
    }
    if (impact) S.impact = true; // CLI --impact — setMode 전 주입 (main에서 --focus 필수 검증)
    if (wantDiff) S.mode = 'diff'; // CLI --diff

    hideWelcome();
    $('welcome-err').hidden = true;
    $('brand-title').textContent = path.split('/').pop() ?? path;
    $('brand-sub').textContent =
      `${model.tables.length} tables · ${model.refs.length} refs (실 ${model.refs.filter((r) => r.kind === 'real').length} / 논리 ${model.refs.filter((r) => r.kind === 'logical').length})` +
      (model.meta.projectName ? ` · ${model.meta.projectName}` : '');
    $('stat-chip').textContent = `${model.tables.length} tables · ${model.refs.length} refs`;
    $('stat-chip').hidden = false;

    buildSidebar(); buildLegend();
    Focus.init(model, S.sem, S, { go, tooltip, back: () => { if (S.hist.length) $('back').click(); } });
    Compare.init(S);
    await Compare.probe(); // 진입 버튼 활성 여부를 먼저 확정 — 캡처 시점의 화면이 매번 같아야 한다
    await ERD.load(model, S.sem, S);
    if (layout) await ERD.arrange(layout); // CLI --layout — arrange와 동일하게 저장까지 수행
    syncArrange(); // 파일별로 저장된 정렬 방식 복원 반영
    await setMode(S.mode); // focus 모드면 여기서 렌더 완료까지 대기
    // CLI --peek: 렌더 완료 후 대상 카드의 .fx를 연다. 이웃이 아니면 즉시 실패(fail-fast).
    if (peek && S.mode === 'focus') {
      if (!Focus.openPeek(peek)) {
        console.error(`--peek ${peek}: 현재 포커스(${S.focusTable})의 이웃이 아님`);
        if (!firstRenderDone) {
          firstRenderDone = true;
          requestAnimationFrame(() => requestAnimationFrame(() => window.dbv.renderDone({ error: true })));
        }
        return;
      }
    }
    // CLI --diff: 기준본을 못 읽었으면 안내 화면을 조용히 찍지 않고 실패로 알린다
    // (--peek/--impact와 같은 규약 — 검증 자동화가 잘못된 경로에서 통과하면 안 된다)
    if (wantDiff && !Compare.ok()) {
      console.error('--diff: 마지막 커밋을 읽을 수 없어 비교할 수 없음');
      if (!firstRenderDone) {
        firstRenderDone = true;
        requestAnimationFrame(() => requestAnimationFrame(() => window.dbv.renderDone({ error: true })));
      }
      return;
    }
    if (!firstRenderDone) {
      firstRenderDone = true;
      requestAnimationFrame(() => requestAnimationFrame(() => window.dbv.renderDone()));
    }
  }

  // ── ERD 콜백 ──
  ERD.mount($('erd') as unknown as SVGSVGElement, {
    onSelect(name: string) { S.selected = name; ERD.select(name); syncSidebarActive(); },
    onOpenFocus(name: string) { go(name); },
    tooltip,
  });

  // ── 툴바 ──
  $('m-erd').addEventListener('click', () => setMode('erd'));
  $('m-diff').addEventListener('click', () => setMode('diff'));
  $('m-focus').addEventListener('click', () => {
    // ERD에서 선택해 둔 테이블이 있으면 그 테이블로 포커스 진입
    if (S.mode === 'erd' && S.selected && tableExists(S.selected)) go(S.selected);
    else setMode('focus');
  });
  const setFilter = (f: Filter): void => {
    S.filter = f;
    $('f-all').setAttribute('aria-pressed', String(f === 'all'));
    $('f-real').setAttribute('aria-pressed', String(f === 'real'));
    ERD.applyFilter();
    if (S.mode === 'focus' && S.focusTable) { Focus.render(S.focusTable); syncCrumb(); }
    if (S.mode === 'diff') Compare.redraw();
  };
  $('f-all').addEventListener('click', () => setFilter('all'));
  $('f-real').addEventListener('click', () => setFilter('real'));
  const setCols = async (m: ColsMode): Promise<void> => {
    S.colsMode = m;
    $('c-keys').setAttribute('aria-pressed', String(m === 'keys'));
    $('c-all').setAttribute('aria-pressed', String(m === 'all'));
    if (S.model) await ERD.load(S.model, S.sem, S);
    if (S.mode === 'focus' && S.focusTable) Focus.render(S.focusTable); // 포커스 카드도 같은 규칙 적용
    if (S.mode === 'diff') await Compare.redraw();                      // 비교 카드도 마찬가지
  };
  $('c-keys').addEventListener('click', () => setCols('keys'));
  $('c-all').addEventListener('click', () => setCols('all'));
  $('fit').addEventListener('click', () => ERD.fit());
  // 하단 정렬 바 — 지도 아래 가로 배치
  const syncArrange = () => {
    const m = ERD.getLayoutMode();
    $('arrange').querySelectorAll('button').forEach((b) =>
      b.setAttribute('aria-pressed', String((b.dataset.mode === m))));
  };
  $('arrange').querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', async () => { await ERD.arrange(b.dataset.mode); syncArrange(); }));
  $('legend-btn').addEventListener('click', () => {
    const l = $('legend');
    l.hidden = !l.hidden;
    $('legend-btn').setAttribute('aria-pressed', String((!l.hidden)));
  });
  const applySide = (open: boolean, persist = true): void => {
    document.body.classList.toggle('side-collapsed', !open);
    $('side-toggle').setAttribute('aria-pressed', String((open)));
    if (persist) localStorage.setItem('dbv-side', open ? 'open' : 'closed');
    ERD.fitIfPending(); // 캔버스 폭 변화에 맞춰 미니맵 뷰포트 갱신
  };
  $('side-toggle').addEventListener('click', () =>
    applySide(document.body.classList.contains('side-collapsed')));
  if (localStorage.getItem('dbv-side') === 'closed') applySide(false);
  $('open').addEventListener('click', () => window.dbv.openFileDialog());
  $('welcome-open').addEventListener('click', () => window.dbv.openFileDialog());
  $('back').addEventListener('click', () => {
    if (!S.hist.length) return;
    const prev = S.hist.pop();
    if (prev) go(prev, true);
    $btn('back').disabled = !S.hist.length;
  });
  $('crumb-path').addEventListener('click', (e) => {
    const a = asEl(e.target)?.closest('a');
    if (!(a instanceof HTMLElement)) return;
    const idx = +(a.dataset['idx'] ?? '0');
    const name = S.hist[idx];
    if (!name) return;
    S.hist = S.hist.slice(0, idx); // 클릭 지점 이후 경로는 버린다
    $btn('back').disabled = !S.hist.length;
    go(name, true);
  });
  $('theme').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('dbv-theme', next);
    if (S.mode === 'focus' && S.focusTable) requestAnimationFrame(Focus.drawWires);
  });

  // ── 검색 ──
  $('q').addEventListener('input', () => {
    const v = $input('q').value.trim().toLowerCase();
    $('list').classList.toggle('searching', !!v); // 검색 중엔 접힌 그룹도 임시로 펼쳐 보임
    $('list').querySelectorAll<HTMLElement>('.item').forEach((i) =>
      i.classList.toggle('hide', !!v && !(i.dataset['name'] ?? '').toLowerCase().includes(v)));
  });

  // ── 키보드 ── (editable 판정은 Focus와 같은 술어 공유 — 계층 간 키 누출 방지)
  document.addEventListener('keydown', (e) => {
    if (Focus.isEditableTarget(e.target)) return; // 공유 술어(input/textarea/contenteditable)
    if (e.key === 'Escape' && !$('schema-menu').hidden) { closeSchemaMenu(); return; }
    if (e.key === 'Escape' && welcomeVisible() && S.model) { hideWelcome(); return; }
    if (welcomeVisible()) return; // 라이브러리/추출 화면에선 캔버스 단축키 비활성
    if (S.mode === 'diff') { // 비교 화면은 읽기 전용 — 맞춤과 빠져나오기만 둔다
      if (e.key === '0') Compare.fit();
      if (e.key === 'Escape') setMode('erd');
      return;
    }
    if (S.mode === 'focus' && Focus.onKey(e)) return; // 포커스 모드 항법 우선 위임
    if (e.key === '0') ERD.fit();
    if (e.key === 'Escape') {
      if (S.mode === 'erd') { S.selected = null; ERD.select(null); syncSidebarActive(); }
      else setMode('erd');
    }
    if (e.key === '/') { e.preventDefault(); $('q').focus(); }
  });

  // ── 드래그앤드롭 ──
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth) document.body.classList.add('dropping'); });
  document.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0; document.body.classList.remove('dropping');
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    const p = window.dbv.pathForFile(f);
    if (p) window.dbv.openPath(p);
  });

  // ── 리사이즈: 포커스 와이어 재계산 ──
  let rt: ReturnType<typeof setTimeout> | undefined;
  addEventListener('resize', () => {
    if (rt !== undefined) clearTimeout(rt);
    rt = setTimeout(() => { if (S.mode === 'focus' && S.focusTable) Focus.drawWires(); }, 120);
  });

  // ── IPC ──
  window.dbv.onModel(onModel);
  window.dbv.onResetLayout(() => ERD.resetLayout());
})();
