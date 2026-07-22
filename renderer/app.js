// 앱 셸: 상태, 사이드바, 툴바, 모드 전환(ERD/포커스), IPC, 드래그앤드롭.
(() => {
  // 기본 테마는 라이트. 사용자가 토글하면 localStorage로 유지, CLI --theme은 세션 한정 오버라이드.
  document.documentElement.setAttribute('data-theme',
    document.documentElement.getAttribute('data-theme') || localStorage.getItem('dbv-theme') || 'light');
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const S = {
    model: null, sem: null, filePath: null,
    mode: 'erd', focusTable: null, lastFocus: null, hist: [],
    filter: 'all', colsMode: 'keys',
    hubShown: {}, selected: null,
    groupColor: {},
  };
  let firstRenderDone = false;
  const tableExists = (n) => !!n && !!S.model && S.model.tables.some((t) => t.name === n);

  // ── 툴팁 ──
  const ttEl = $('tooltip');
  const tooltip = {
    show(html, x, y) { ttEl.innerHTML = html; ttEl.style.display = 'block'; tooltip.move(x, y); },
    move(x, y) {
      const r = ttEl.getBoundingClientRect();
      ttEl.style.left = Math.min(x + 14, innerWidth - r.width - 8) + 'px';
      ttEl.style.top = Math.min(y + 16, innerHeight - r.height - 8) + 'px';
    },
    hide() { ttEl.style.display = 'none'; },
  };

  // ── 모드 전환 ──
  function setMode(mode) {
    S.mode = mode;
    $('erdwrap').style.display = mode === 'erd' ? 'block' : 'none';
    $('focuswrap').style.display = mode === 'focus' ? 'block' : 'none';
    $('m-erd').setAttribute('aria-pressed', mode === 'erd');
    $('m-focus').setAttribute('aria-pressed', mode === 'focus');
    $('crumb').hidden = mode !== 'focus';
    if (mode === 'focus') {
      if (!S.focusTable) S.focusTable = defaultFocusTable();
      Focus.render(S.focusTable);
      S.lastFocus = S.focusTable;
      syncCrumb();
    } else {
      ERD.fitIfPending(); // 포커스 모드 중 미뤄둔 fit 실행
    }
    syncSidebarActive();
  }
  function defaultFocusTable() {
    // 차수(degree) 최대 테이블로 시작
    let best = null, bd = -1;
    for (const t of S.model.tables) {
      const d = (S.sem.tableMeta[t.name] || {}).degree || 0;
      if (d > bd) { bd = d; best = t.name; }
    }
    return best;
  }
  function go(name, fromHist) {
    // 히스토리에는 실제로 렌더된 적 있는 포커스(lastFocus)만 쌓는다
    if (S.mode !== 'focus') {
      if (S.lastFocus && S.lastFocus !== name && !fromHist) { S.hist.push(S.lastFocus); $('back').disabled = false; }
      S.focusTable = name;
      setMode('focus');
      return;
    }
    if (name === S.focusTable && !fromHist) return;
    if (S.lastFocus && !fromHist) { S.hist.push(S.lastFocus); $('back').disabled = false; }
    S.focusTable = name;
    Focus.render(name);
    S.lastFocus = name;
    syncCrumb(); syncSidebarActive();
  }
  // 크럼 수치는 포커스 카드 하단과 같은 기준(고유 테이블 수, 필터 반영)
  function syncCrumb() {
    $('crumb-now').textContent = S.focusTable || '—';
    const cs = new Set(), ps = new Set();
    for (const r of S.model.refs) {
      if (S.filter === 'real' && r.kind === 'logical') continue;
      if (r.self) continue;
      if (r.parent.table === S.focusTable) cs.add(r.child.table);
      if (r.child.table === S.focusTable) ps.add(r.parent.table);
    }
    $('crumb-deg').textContent = `피참조 ${cs.size} · 참조 ${ps.size}`;
  }

  // ── 사이드바 ──
  function buildSidebar() {
    const list = $('list');
    list.innerHTML = '';
    const grouped = new Set();
    const addItem = (t, gv) => {
      const it = document.createElement('div');
      it.className = 'item'; it.dataset.name = t.name; it.tabIndex = 0;
      it.setAttribute('role', 'button');
      it.style.setProperty('--gc', `var(${gv})`);
      const d = (S.sem.tableMeta[t.name] || {}).degree || 0;
      it.innerHTML = `<span class="nm">${esc(t.name)}</span><span class="deg">${d}</span>`;
      const act = () => {
        if (S.mode === 'erd') { S.selected = t.name; ERD.select(t.name); ERD.centerOn(t.name); }
        else go(t.name);
        syncSidebarActive();
      };
      it.addEventListener('click', act);
      it.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } });
      list.appendChild(it);
    };
    for (const g of S.model.groups) {
      const members = S.model.tables.filter((t) => t.group === g.name);
      if (!members.length) continue;
      members.forEach((t) => grouped.add(t.name));
      const gv = S.groupColor[g.name];
      const lab = document.createElement('div');
      lab.className = 'grp-lab'; lab.style.setProperty('--gc', `var(${gv})`);
      lab.innerHTML = `<i></i>${esc(g.name)}`;
      list.appendChild(lab);
      members.forEach((t) => addItem(t, gv));
    }
    const rest = S.model.tables.filter((t) => !grouped.has(t.name));
    if (rest.length) {
      const lab = document.createElement('div');
      lab.className = 'grp-lab'; lab.style.setProperty('--gc', 'var(--gc-x)');
      lab.innerHTML = `<i></i>ungrouped`;
      list.appendChild(lab);
      rest.forEach((t) => addItem(t, '--gc-x'));
    }
  }
  function syncSidebarActive() {
    const active = S.mode === 'erd' ? S.selected : S.focusTable;
    $('list').querySelectorAll('.item').forEach((i) => i.classList.toggle('active', i.dataset.name === active));
    const a = $('list').querySelector('.item.active');
    if (a) a.scrollIntoView({ block: 'nearest' });
  }

  // ── 범례 ──
  function buildLegend() {
    $('tlegend').innerHTML = Object.values(S.sem.TYPES)
      .map((t) => `<span class="tc" style="--c:var(${t.cssVar})">${t.label}</span>`).join('');
    const ht = $('hub-toggles');
    ht.innerHTML = '';
    if (!S.sem.hubs.length) { ht.innerHTML = '<span style="color:var(--faint)">허브 없음</span>'; return; }
    for (const h of S.sem.hubs) {
      const lab = document.createElement('label');
      lab.className = 'hub-tg';
      lab.title = `${h.table}(으)로 들어오는 엣지 ${h.inDegree}개 — 기본 접힘(카드 하단 칩으로 표시)`;
      lab.innerHTML = `<input type="checkbox" ${S.hubShown[h.table] ? 'checked' : ''}> ${h.table} 엣지 <b>${h.inDegree}</b>`;
      lab.querySelector('input').addEventListener('change', (e) => {
        S.hubShown[h.table] = e.target.checked;
        ERD.applyHubToggles();
      });
      ht.appendChild(lab);
    }
  }

  // ── 모델 수신 ──
  async function onModel({ model, path, focus, theme, error }) {
    if (theme === 'light' || theme === 'dark')
      document.documentElement.setAttribute('data-theme', theme);
    if (error) {
      if (S.model && S.filePath === path) {
        // 편집 중 일시적 문법 오류 — 기존 다이어그램을 유지하고 배너만 표시
        $('errbar').hidden = false;
        $('errbar-msg').textContent = ` ${error}`;
      } else {
        $('welcome').style.display = 'flex';
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
    const keepFile = S.filePath === path;
    S.model = model; S.filePath = path;
    S.sem = Semantics.analyze(model);
    S.groupColor = {};
    model.groups.forEach((g, i) => { S.groupColor[g.name] = '--gc-' + (i % 10); });
    if (!keepFile) {
      S.hubShown = {}; S.selected = null; S.hist = []; S.focusTable = null; S.lastFocus = null;
      $('back').disabled = true;
      S.sem.hubs.forEach((h) => { S.hubShown[h.table] = false; });
    } else {
      // 재파싱으로 사라진 테이블에 대한 stale 상태 정리
      if (!tableExists(S.selected)) S.selected = null;
      if (!tableExists(S.focusTable)) { S.focusTable = null; S.lastFocus = null; }
      if (!tableExists(S.lastFocus)) S.lastFocus = null;
      S.hist = S.hist.filter(tableExists);
      $('back').disabled = !S.hist.length;
      const hs = {};
      S.sem.hubs.forEach((h) => { hs[h.table] = !!S.hubShown[h.table]; });
      S.hubShown = hs;
    }
    if (focus) {
      if (model.tables.some((t) => t.name === focus)) { S.focusTable = focus; S.mode = 'focus'; }
      else console.warn(`--focus ${focus}: 테이블이 없어 무시`);
    }

    $('welcome').style.display = 'none';
    $('welcome-err').hidden = true;
    $('legend').hidden = false;
    $('brand-title').textContent = path.split('/').pop();
    $('brand-sub').textContent =
      `${model.tables.length} tables · ${model.refs.length} refs (실 ${model.refs.filter((r) => r.kind === 'real').length} / 논리 ${model.refs.filter((r) => r.kind === 'logical').length})` +
      (model.meta.projectName ? ` · ${model.meta.projectName}` : '');

    buildSidebar(); buildLegend();
    Focus.init(model, S.sem, S, { go });
    await ERD.load(model, S.sem, S);
    setMode(S.mode); // focus 모드면 여기서 렌더까지 수행
    if (!firstRenderDone) {
      firstRenderDone = true;
      requestAnimationFrame(() => requestAnimationFrame(() => window.dbv.renderDone()));
    }
  }

  // ── ERD 콜백 ──
  ERD.mount($('erd'), {
    onSelect(name) { S.selected = name; ERD.select(name); syncSidebarActive(); },
    onOpenFocus(name) { go(name); },
    tooltip,
  });

  // ── 툴바 ──
  $('m-erd').addEventListener('click', () => setMode('erd'));
  $('m-focus').addEventListener('click', () => setMode('focus'));
  const setFilter = (f) => {
    S.filter = f;
    $('f-all').setAttribute('aria-pressed', f === 'all');
    $('f-real').setAttribute('aria-pressed', f === 'real');
    ERD.applyFilter();
    if (S.mode === 'focus' && S.focusTable) { Focus.render(S.focusTable); syncCrumb(); }
  };
  $('f-all').addEventListener('click', () => setFilter('all'));
  $('f-real').addEventListener('click', () => setFilter('real'));
  const setCols = async (m) => {
    S.colsMode = m;
    $('c-keys').setAttribute('aria-pressed', m === 'keys');
    $('c-all').setAttribute('aria-pressed', m === 'all');
    if (S.model) await ERD.load(S.model, S.sem, S);
  };
  $('c-keys').addEventListener('click', () => setCols('keys'));
  $('c-all').addEventListener('click', () => setCols('all'));
  $('fit').addEventListener('click', () => ERD.fit());
  const applySide = (open) => {
    document.body.classList.toggle('side-collapsed', !open);
    $('side-toggle').setAttribute('aria-pressed', String(open));
    localStorage.setItem('dbv-side', open ? 'open' : 'closed');
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
    go(prev, true);
    $('back').disabled = !S.hist.length;
  });
  $('theme').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('dbv-theme', next);
    if (S.mode === 'focus' && S.focusTable) requestAnimationFrame(Focus.drawWires);
  });

  // ── 검색 ──
  $('q').addEventListener('input', () => {
    const v = $('q').value.trim().toLowerCase();
    $('list').querySelectorAll('.item').forEach((i) =>
      i.classList.toggle('hide', !!v && !i.dataset.name.toLowerCase().includes(v)));
  });

  // ── 키보드 ──
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
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
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    const p = window.dbv.pathForFile(f);
    if (p) window.dbv.openPath(p);
  });

  // ── 리사이즈: 포커스 와이어 재계산 ──
  let rt;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (S.mode === 'focus' && S.focusTable) Focus.drawWires(); }, 120);
  });

  // ── IPC ──
  window.dbv.onModel(onModel);
  window.dbv.onResetLayout(() => ERD.resetLayout());
})();
