// 전체 ERD 캔버스: elk 자동배치 + SVG 렌더 + 줌/팬 + 노드 드래그 + 관계 하이라이트.
// 허브(users 등) 유입 엣지는 기본 접힘 → 카드 하단 칩으로 축약, 선택/토글 시에만 표시.
const ERD = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 232, HDR = 28, ROW = 18, CHIP = 20, PADB = 8;

  let svg, vp, cb;                 // cb: {onSelect,onOpenFocus,tooltip}
  let model, sem, S;
  let pos = {};                    // table → {x,y,w,h,rowY:{col:y}}
  let edgeEls = [];                // {el, ref, meta}
  let nodeEls = {};                // table → g
  let hullByGroup = {};            // group → {rect, lab} — 노드 드래그 시 헐 실시간 리사이즈용
  let tf = { x: 40, y: 40, k: 1 };
  let customLayout = false;
  let pendingFit = false;

  const el = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };
  const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ── 표시 행 계산 ─────────────────────────────────────────
  function rowsFor(t) {
    const fkCols = new Set(model.refs.filter((r) => r.child.table === t.name).map((r) => r.child.cols[0]));
    let shown = S.colsMode === 'all' ? t.cols : t.cols.filter((c) => c.pk || c.unique || fkCols.has(c.name));
    if (!shown.length) shown = t.cols.slice(0, 1);
    return { shown, hidden: t.cols.length - shown.length, fkCols };
  }
  function hubLinksFor(tname) {
    const links = [];
    for (const h of sem.hubs) {
      const rs = model.refs.filter((r) => r.child.table === tname && r.parent.table === h.table && !r.self);
      if (rs.length) links.push({ hub: h.table, refs: rs });
    }
    return links;
  }
  function nodeSize(t) {
    const { shown, hidden } = rowsFor(t);
    const chips = hubLinksFor(t.name).length;
    const rows = shown.length + (hidden > 0 ? 1 : 0);
    return { w: W, h: HDR + 4 + rows * ROW + chips * CHIP + PADB };
  }

  // ── 레이아웃 ─────────────────────────────────────────────
  function posStoreKey() { return `dbv-pos:${S.filePath || 'untitled'}`; }
  function savePositions() {
    try {
      const out = {};
      for (const k in pos) out[k] = { x: Math.round(pos[k].x), y: Math.round(pos[k].y) };
      localStorage.setItem(posStoreKey(), JSON.stringify(out));
    } catch {}
  }
  function loadPositions() {
    try { return JSON.parse(localStorage.getItem(posStoreKey())); } catch { return null; }
  }
  function clearPositions() { localStorage.removeItem(posStoreKey()); customLayout = false; }

  async function computeLayout() {
    const saved = loadPositions();
    if (saved && model.tables.every((t) => saved[t.name])) {
      pos = {};
      for (const t of model.tables) {
        const s = nodeSize(t);
        pos[t.name] = { x: saved[t.name].x, y: saved[t.name].y, w: s.w, h: s.h, rowY: {} };
      }
      customLayout = true;
      return;
    }
    const hubSet = new Set(sem.hubs.map((h) => h.table));
    const groups = model.groups.filter((g) => g.tables.some((tn) => model.tables.some((t) => t.name === tn)));
    const grouped = new Set();
    const nodeOf = (t) => { const s = nodeSize(t); return { id: t.name, width: s.w, height: s.h }; };
    const children = [];
    for (const g of groups) {
      const members = model.tables.filter((t) => t.group === g.name);
      if (!members.length) continue;
      members.forEach((t) => grouped.add(t.name));
      children.push({
        id: 'g:' + g.name,
        // 그룹 내부 간격은 이 컴파운드 노드의 옵션이 지배 — 루트 옵션만으로는 부족
        layoutOptions: {
          'elk.padding': '[top=52,left=30,bottom=30,right=30]',
          'elk.spacing.nodeNode': '76',
          'elk.layered.spacing.nodeNodeBetweenLayers': '128',
        },
        children: members.map(nodeOf),
      });
    }
    for (const t of model.tables) if (!grouped.has(t.name)) children.push(nodeOf(t));
    // 레이아웃용 엣지: 구조 엣지만(허브 유입/셀프 제외) — 접힌 엣지가 배치를 흔들지 않게
    const edges = model.refs
      .filter((r) => !r.self && !hubSet.has(r.parent.table))
      .map((r, i) => ({ id: 'e' + i, sources: [r.child.table], targets: [r.parent.table] }));

    const elk = new ELK();
    const res = await elk.layout({
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        'elk.layered.spacing.nodeNodeBetweenLayers': '104',
        'elk.spacing.nodeNode': '56',
        'elk.spacing.componentComponent': '88',
        'elk.layered.mergeEdges': 'true',
      },
      children, edges,
    });
    pos = {};
    (function walk(node, ox, oy) {
      for (const c of node.children || []) {
        if (c.id.startsWith('g:')) walk(c, ox + c.x, oy + c.y);
        else {
          const t = model.tables.find((x) => x.name === c.id);
          const s = nodeSize(t);
          pos[c.id] = { x: ox + c.x, y: oy + c.y, w: s.w, h: s.h, rowY: {} };
        }
      }
    })(res, 0, 0);
    customLayout = false;
  }

  // ── 렌더 ────────────────────────────────────────────────
  function applyTf() {
    vp.setAttribute('transform', `translate(${tf.x},${tf.y}) scale(${tf.k})`);
    // 그룹 라벨은 줌아웃 시 화면 크기를 유지하도록 역보정 — 어느 배율에서도 그룹명이 읽히게
    const fs = Math.max(11, Math.min(11 / tf.k, 30));
    for (const gname in hullByGroup) hullByGroup[gname].lab.style.fontSize = fs + 'px';
    updateMinimapView();
  }

  function render() {
    if (cb && cb.tooltip) cb.tooltip.hide(); // 재렌더 시 툴팁 고착 방지
    grid = null; // 배치가 바뀌었을 수 있으므로 라우팅 격자 무효화
    svg.innerHTML = '';
    vp = el('g', { id: 'vp' }, svg);
    const hullLayer = el('g', {}, vp);
    const edgeLayer = el('g', {}, vp);
    const nodeLayer = el('g', {}, vp);
    edgeEls = []; nodeEls = {}; hullByGroup = {};

    // 그룹 헐
    for (const g of model.groups) {
      const members = model.tables.filter((t) => t.group === g.name && pos[t.name]);
      if (!members.length) continue;
      const b = hullBox(members);
      const gv = S.groupColor[g.name] || '--gc-x';
      const hg = el('g', { class: 'hullg', style: `--gc:var(${gv})` }, hullLayer);
      hg.dataset.group = g.name;
      const rect = el('rect', { class: 'hull', x: b.x, y: b.y, width: b.w, height: b.h, rx: 14 }, hg);
      const lab = el('text', { class: 'hull-label', x: b.x + 13, y: b.y + 19 }, hg);
      lab.textContent = `${g.name}  · ${members.length}`;
      hullByGroup[g.name] = { rect, lab };
    }

    // 노드
    for (const t of model.tables) {
      if (!pos[t.name]) continue;
      nodeLayer.appendChild(nodeEl(t));
    }
    // 엣지 (노드 위 배치 순서상 엣지가 아래)
    const hubSet = new Set(sem.hubs.map((h) => h.table));
    for (const r of model.refs) {
      const meta = sem.refMeta[r.id];
      const g = el('g', {
        class: `edge ${meta.type}${r.kind === 'logical' ? ' logical' : ''}${!r.self && hubSet.has(r.parent.table) ? ' hub' : ''}`,
        style: `--c:var(${sem.TYPES[meta.type].cssVar})`,
      }, edgeLayer);
      g.dataset.hub = !r.self && hubSet.has(r.parent.table) ? r.parent.table : '';
      g.dataset.child = r.child.table; g.dataset.parent = r.parent.table;
      drawEdge(g, r, meta);
      hookEdge(g, r, meta);
      edgeEls.push({ el: g, ref: r, meta });
    }
    applyHubToggles();
    buildMinimap();
    applyTf();
  }

  function nodeEl(t) {
    const p = pos[t.name];
    const { shown, hidden, fkCols } = rowsFor(t);
    const links = hubLinksFor(t.name);
    const gv = S.groupColor[t.group] || '--gc-x';
    const tm = sem.tableMeta[t.name] || {};
    const g = el('g', { class: 'node', transform: `translate(${p.x},${p.y})`, style: `--gc:var(${gv})` });
    g.dataset.name = t.name;
    el('rect', { class: 'box', width: p.w, height: p.h, rx: 10 }, g);
    el('path', { class: 'hd', d: `M0 10 a10 10 0 0 1 10 -10 H${p.w - 10} a10 10 0 0 1 10 10 V${HDR} H0 Z` }, g);
    el('rect', { class: 'accentbar', x: 0, y: 4, width: 3, height: p.h - 8, rx: 1.5 }, g);
    const title = el('text', { class: 'title', x: 11, y: 17 }, g);
    title.textContent = trunc(t.name, 26);
    let bx = 11 + Math.min(t.name.length, 26) * 6.9 + 6;
    if (tm.junction) {
      el('rect', { class: 'badge-jn-bg', x: bx, y: 6, width: 27, height: 13, rx: 4 }, g);
      const bt = el('text', { class: 'badge-jn', x: bx + 4, y: 16 }, g); bt.textContent = 'N:M';
      bx += 31;
    }
    if (tm.selfRef) { const s = el('text', { class: 'selfglyph', x: p.w - 16, y: 16 }, g); s.textContent = '⟲'; }

    p.rowY = {};
    let y = HDR + 4;
    for (const c of shown) {
      const cy = y + ROW / 2 + 1;
      p.rowY[c.name] = cy;
      let x = 9;
      if (c.pk) { const b = el('text', { x, y: cy + 3, style: 'font-size:7.5px;font-weight:700;fill:var(--pk)' }, g); b.textContent = 'PK'; x += 15; }
      if (c.unique) { const b = el('text', { x, y: cy + 3, style: 'font-size:7.5px;font-weight:700;fill:var(--uq)' }, g); b.textContent = 'UQ'; x += 15; }
      const nm = el('text', { class: 'cn' + (c.pk ? ' pk' : ''), x: Math.max(x, 26), y: cy + 3.5 }, g);
      nm.textContent = trunc(c.name, 18);
      const ref = fkCols.has(c.name) && model.refs.find((r) => r.child.table === t.name && r.child.cols[0] === c.name);
      if (ref) {
        const meta = sem.refMeta[ref.id];
        const ft = el('text', {
          class: `fkTo${ref.kind === 'logical' ? ' logical' : ''}`, x: p.w - 9, y: cy + 3.5,
          'text-anchor': 'end', style: `fill:var(${sem.TYPES[meta.type].cssVar})`,
        }, g);
        ft.textContent = trunc((ref.self ? '⟲ ' : '→ ') + ref.parent.table, 15);
      } else {
        const ct = el('text', { class: 'ct', x: p.w - 9, y: cy + 3.5, 'text-anchor': 'end' }, g);
        ct.textContent = trunc(c.type, 13);
      }
      y += ROW;
    }
    if (hidden > 0) {
      const m = el('text', { class: 'more', x: 11, y: y + ROW / 2 + 4 }, g);
      m.textContent = `… ${hidden}개 컬럼 더`;
      y += ROW;
    }
    for (const L of links) {
      const cy = y + 2;
      el('rect', { class: 'hubchip-bg', x: 8, y: cy, width: p.w - 16, height: 16, rx: 8 }, g);
      const labels = [...new Set(L.refs.map((r) => sem.refMeta[r.id].label))].join('·');
      const tx = el('text', { class: 'hubchip', x: 15, y: cy + 11.5 }, g);
      tx.textContent = trunc(`◦ ${L.hub} — ${labels}`, 32);
      const hit = el('rect', { x: 8, y: cy, width: p.w - 16, height: 16, fill: 'transparent', style: 'pointer-events:all;cursor:default' }, g);
      hit.addEventListener('pointerenter', () => setHubHot(t.name, L.hub, true));
      hit.addEventListener('pointerleave', () => setHubHot(t.name, L.hub, false));
      y += CHIP;
    }
    nodeEls[t.name] = g;
    return g;
  }

  function hullBox(members) {
    const xs = members.map((t) => pos[t.name].x), ys = members.map((t) => pos[t.name].y);
    const x2 = Math.max(...members.map((t) => pos[t.name].x + pos[t.name].w));
    const y2 = Math.max(...members.map((t) => pos[t.name].y + pos[t.name].h));
    const x = Math.min(...xs) - 16, y = Math.min(...ys) - 38;
    return { x, y, w: x2 + 16 - x, h: y2 + 14 - y };
  }
  // 멤버 하나가 움직여도 헐이 항상 그룹 전체를 감싸도록 재계산
  function updateHull(gname) {
    const h = hullByGroup[gname];
    if (!h) return;
    const members = model.tables.filter((t) => t.group === gname && pos[t.name]);
    if (!members.length) return;
    const b = hullBox(members);
    h.rect.setAttribute('x', b.x); h.rect.setAttribute('y', b.y);
    h.rect.setAttribute('width', b.w); h.rect.setAttribute('height', b.h);
    h.lab.setAttribute('x', b.x + 13); h.lab.setAttribute('y', b.y + 19);
  }

  function setHubHot(child, hub, on) {
    for (const e of edgeEls) {
      if (e.ref.child.table === child && e.ref.parent.table === hub)
        e.el.classList.toggle('hot', on);
    }
  }

  // ── 엣지 지오메트리 ──────────────────────────────────────
  // 선분-사각형 교차 (Liang–Barsky)
  function segHitsRect(x1, y1, x2, y2, rx, ry, rw, rh) {
    let t0 = 0, t1 = 1;
    const dx = x2 - x1, dy = y2 - y1;
    const clip = (p, q) => {
      if (p === 0) return q >= 0;
      const t = q / p;
      if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
      return true;
    };
    return clip(-dx, x1 - rx) && clip(dx, rx + rw - x1) &&
           clip(-dy, y1 - ry) && clip(dy, ry + rh - y1) && t0 <= t1;
  }
  // 기본 곡선: 단일 큐빅
  function curveSegs(cx, cy, px, py, parentRight) {
    const dx = Math.max(46, Math.abs(px - cx) * 0.42);
    const c1 = parentRight ? cx + dx : cx - dx;
    const c2 = parentRight ? px - dx : px + dx;
    return [[cx, cy, c1, cy, c2, py, px, py]];
  }
  function segsToPath(segs) {
    let d = `M${segs[0][0]},${segs[0][1]}`;
    for (const s of segs) d += ` C${s[2]},${s[3]} ${s[4]},${s[5]} ${s[6]},${s[7]}`;
    return d;
  }
  // 실제 그려질 곡선을 폴리라인으로 샘플링 — 직선(chord) 검사는 베지어 부풀음을 놓친다
  function sampleSegs(segs, n) {
    const pts = [];
    for (const s of segs) {
      for (let i = 0; i <= n; i++) {
        const t = i / n, u = 1 - t;
        pts.push([
          u * u * u * s[0] + 3 * u * u * t * s[2] + 3 * u * t * t * s[4] + t * t * t * s[6],
          u * u * u * s[1] + 3 * u * u * t * s[3] + 3 * u * t * t * s[5] + t * t * t * s[7],
        ]);
      }
    }
    return pts;
  }
  function curveBlockers(segs, skipA, skipB) {
    const M = 10;
    const pts = sampleSegs(segs, 10);
    let top = Infinity, bot = -Infinity, hit = false;
    for (const k in pos) {
      if (k === skipA || k === skipB) continue;
      const b = pos[k];
      const rx = b.x - M, ry = b.y - M, rw = b.w + 2 * M, rh = b.h + 2 * M;
      for (let i = 0; i < pts.length - 1; i++) {
        if (segHitsRect(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], rx, ry, rw, rh)) {
          hit = true; top = Math.min(top, b.y); bot = Math.max(bot, b.y + b.h); break;
        }
      }
    }
    return hit ? { top, bot } : null;
  }
  // ── 격자 A* 라우팅 ──
  // 기본 곡선이 카드에 막히면, 카드 사이 통로를 지나는 직각(라운드 코너) 경로를 찾는다.
  // 선이 엔티티를 통과하지 않는 것이 전체 ERD 가독성의 전제.
  const CELL = 24, GRID_MARGIN = 28, INFLATE = 10;
  let grid = null;                 // 노드 위치 확정 변경 시 null로 무효화
  let fastPreview = false;         // 드래그 중에는 빠른 기본 곡선만 (확정 시 전체 재라우팅)

  function ensureGrid() {
    if (grid) return grid;
    let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
    for (const k in pos) {
      x1 = Math.min(x1, pos[k].x); y1 = Math.min(y1, pos[k].y);
      x2 = Math.max(x2, pos[k].x + pos[k].w); y2 = Math.max(y2, pos[k].y + pos[k].h);
    }
    if (x2 < x1) return null;
    const x = x1 - GRID_MARGIN, y = y1 - GRID_MARGIN;
    const cols = Math.ceil((x2 - x1 + GRID_MARGIN * 2) / CELL);
    const rows = Math.ceil((y2 - y1 + GRID_MARGIN * 2) / CELL);
    const blocked = new Uint8Array(cols * rows);
    for (const k in pos) {
      const b = pos[k];
      const i1 = Math.max(0, Math.floor((b.x - INFLATE - x) / CELL));
      const i2 = Math.min(cols - 1, Math.floor((b.x + b.w + INFLATE - x) / CELL));
      const j1 = Math.max(0, Math.floor((b.y - INFLATE - y) / CELL));
      const j2 = Math.min(rows - 1, Math.floor((b.y + b.h + INFLATE - y) / CELL));
      for (let j = j1; j <= j2; j++) for (let i = i1; i <= i2; i++) blocked[j * cols + i] = 1;
    }
    grid = {
      x, y, cols, rows, blocked,
      dist: new Float64Array(cols * rows * 4),
      stamp: new Int32Array(cols * rows * 4),
      prev: new Int32Array(cols * rows * 4),
      gen: 0,
    };
    return grid;
  }

  // (wx,wy)에서 dir 방향으로 나가며 만나는 첫 자유 셀. dir: 0=+x, 1=-x
  function freeCellFrom(g, wx, wy, dir) {
    let i = Math.floor((wx - g.x) / CELL);
    const j = Math.floor((wy - g.y) / CELL);
    const di = dir === 0 ? 1 : -1;
    for (let s = 0; s < 60; s++) {
      if (i < 0 || j < 0 || i >= g.cols || j >= g.rows) return null;
      if (!g.blocked[j * g.cols + i]) return [i, j];
      i += di;
    }
    return null;
  }

  function gridRoute(cx, cy, px, py, parentRight) {
    const g = ensureGrid();
    if (!g) return null;
    const start = freeCellFrom(g, cx, cy, parentRight ? 0 : 1);
    const goal = freeCellFrom(g, px, py, parentRight ? 1 : 0);
    if (!start || !goal) return null;
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const W = g.cols, H = g.rows;
    const gen = ++g.gen;
    const seen = (k) => g.stamp[k] === gen;
    const sKey = (start[1] * W + start[0]) * 4 + (parentRight ? 0 : 1);
    g.stamp[sKey] = gen; g.dist[sKey] = 0; g.prev[sKey] = -1;
    const heap = [[Math.abs(start[0] - goal[0]) + Math.abs(start[1] - goal[1]), sKey]];
    const push = (it) => {
      heap.push(it);
      for (let i = heap.length - 1; i > 0;) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        const t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        for (let i = 0; ;) {
          const l = i * 2 + 1, r = l + 1; let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          const t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m;
        }
      }
      return top;
    };
    let found = -1, guard = 0;
    while (heap.length && guard++ < 200000) {
      const [, key] = pop();
      const dir = key & 3, cell = key >> 2, ci = cell % W, cj = (cell / W) | 0;
      if (ci === goal[0] && cj === goal[1]) { found = key; break; }
      const d0 = g.dist[key];
      for (let nd = 0; nd < 4; nd++) {
        const ni = ci + DIRS[nd][0], nj = cj + DIRS[nd][1];
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        if (g.blocked[nj * W + ni]) continue;
        const nk = (nj * W + ni) * 4 + nd;
        const cost = d0 + 1 + (nd === dir ? 0 : 1.6); // 턴 페널티 — 꺾임 최소화
        if (!seen(nk) || cost < g.dist[nk]) {
          g.stamp[nk] = gen; g.dist[nk] = cost; g.prev[nk] = key;
          push([cost + Math.abs(ni - goal[0]) + Math.abs(nj - goal[1]), nk]);
        }
      }
    }
    if (found < 0) return null;
    // 셀 경로 복원 → 방향 전환점만 추출 → 월드 waypoint
    const cells = [];
    for (let k = found; k >= 0; k = g.prev[k]) cells.push(k >> 2);
    cells.reverse();
    const cpt = cells.map((c) => [c % W, (c / W) | 0]);
    const turns = [cpt[0]];
    for (let k = 1; k < cpt.length - 1; k++) {
      if (cpt[k][0] - cpt[k - 1][0] !== cpt[k + 1][0] - cpt[k][0] ||
          cpt[k][1] - cpt[k - 1][1] !== cpt[k + 1][1] - cpt[k][1]) turns.push(cpt[k]);
    }
    if (cpt.length > 1) turns.push(cpt[cpt.length - 1]);
    const wp = turns.map(([i, j]) => [g.x + i * CELL + CELL / 2, g.y + j * CELL + CELL / 2]);
    // 시작 스텁을 자식 행 높이에, 끝 스텁을 부모 진입 높이에 맞춘다
    if (wp.length > 1 && Math.abs(wp[0][1] - cy) <= CELL) wp[0][1] = cy;
    const last = wp[wp.length - 1];
    if (wp.length > 1 && Math.abs(last[1] - py) <= CELL) last[1] = py;
    wp.unshift([cx, cy]);
    wp.push([px, py]);
    return wp;
  }

  function roundedPath(wp) {
    let d = `M${wp[0][0]},${wp[0][1]}`;
    for (let k = 1; k < wp.length - 1; k++) {
      const a = wp[k - 1], b = wp[k], c = wp[k + 1];
      const v1 = [b[0] - a[0], b[1] - a[1]], v2 = [c[0] - b[0], c[1] - b[1]];
      const l1 = Math.hypot(v1[0], v1[1]), l2 = Math.hypot(v2[0], v2[1]);
      if (!l1 || !l2) continue;
      const rr = Math.min(12, l1 / 2, l2 / 2);
      d += ` L${b[0] - (v1[0] / l1) * rr},${b[1] - (v1[1] / l1) * rr}` +
           ` Q${b[0]},${b[1]} ${b[0] + (v2[0] / l2) * rr},${b[1] + (v2[1] / l2) * rr}`;
    }
    d += ` L${wp[wp.length - 1][0]},${wp[wp.length - 1][1]}`;
    return d;
  }

  // 막히지 않으면 부드러운 기본 곡선, 막히면 격자 우회 경로
  function routeEdge(r, cx, cy, px, py, parentRight) {
    const direct = curveSegs(cx, cy, px, py, parentRight);
    if (fastPreview || !curveBlockers(direct, r.child.table, r.parent.table))
      return segsToPath(direct);
    const wp = gridRoute(cx, cy, px, py, parentRight);
    return wp ? roundedPath(wp) : segsToPath(direct);
  }

  function drawEdge(g, r, meta) {
    g.innerHTML = '';
    const c = pos[r.child.table], p = pos[r.parent.table];
    if (!c || !p) return;
    let d, ax, ay, tipDir, labX, labY;
    if (r.self) {
      const x = c.x + c.w, y1 = c.y + (c.rowY[r.child.cols[0]] || 15), y2 = c.y + 9;
      d = `M${x},${y1} C${x + 46},${y1} ${x + 46},${y2} ${x + 2},${y2}`;
      ax = x + 2; ay = y2; tipDir = -1; labX = x + 30; labY = (y1 + y2) / 2;
      var dotX = x, dotY = y1;
    } else {
      const cy = c.y + (c.rowY[r.child.cols[0]] || 15);
      const py = p.y + 14;
      const parentRight = p.x + p.w / 2 >= c.x + c.w / 2;
      const cx = parentRight ? c.x + c.w : c.x;
      const px = parentRight ? p.x : p.x + p.w;
      d = routeEdge(r, cx, cy, px, py, parentRight);
      ax = px; ay = py; tipDir = parentRight ? 1 : -1;
      labX = px - tipDir * 20; labY = py - 7;
      dotX = cx; dotY = cy;
    }
    el('path', { class: 'hit', d }, g);
    el('path', { class: 'vis', d }, g);
    el('circle', { cx: dotX, cy: dotY, r: 3 }, g);
    el('path', { d: `M${ax},${ay} l${-tipDir * 8},-3.6 v7.2 Z`, style: 'fill:var(--c)' }, g);
    const lab = el('text', { class: 'card-lab', x: labX, y: labY, 'text-anchor': 'middle' }, g);
    lab.textContent = meta.card;
  }
  function redrawEdgesTouching(tname) {
    for (const e of edgeEls) {
      if (!tname || e.ref.child.table === tname || e.ref.parent.table === tname) {
        drawEdge(e.el, e.ref, e.meta);
        hookEdge(e.el, e.ref, e.meta);
      }
    }
  }
  function redrawEdgesTouchingSet(set) {
    for (const e of edgeEls) {
      if (set.has(e.ref.child.table) || set.has(e.ref.parent.table)) {
        drawEdge(e.el, e.ref, e.meta);
        hookEdge(e.el, e.ref, e.meta);
      }
    }
  }
  // 드래그 확정 후: 라우팅은 모든 노드 위치에 의존하므로 비인접 엣지까지 전부 재계산
  function settleAfterMove() {
    fastPreview = false;
    grid = null;
    redrawEdgesTouching(null);
    buildMinimap();
    if (S.selected) select(S.selected);
  }
  function hookEdge(g, r, meta) {
    const hit = g.querySelector('.hit');
    if (!hit) return;
    hit.addEventListener('pointerenter', (ev) => {
      g.classList.add('hot');
      cb.tooltip.show(edgeTooltipHtml(r, meta), ev.clientX, ev.clientY);
    });
    hit.addEventListener('pointermove', (ev) => cb.tooltip.move(ev.clientX, ev.clientY));
    hit.addEventListener('pointerleave', () => { g.classList.remove('hot'); cb.tooltip.hide(); });
  }
  function edgeTooltipHtml(r, meta) {
    const ty = sem.TYPES[meta.type];
    return `<div class="tt-head">${esc(r.child.table)}.${esc(r.child.cols.join(','))} → ${esc(r.parent.table)}.${esc(r.parent.cols.join(','))}</div>
      <div class="tt-chips">
        <span class="ty" style="--c:var(${ty.cssVar})">${ty.label}</span>
        <span class="kd">${meta.card}</span>
        <span class="kd">${r.kind === 'real' ? '실 DB FK' : '논리 FK'}</span>
        ${r.onDelete ? `<span class="kd">on delete ${esc(r.onDelete)}</span>` : ''}
      </div>
      <b>${esc(meta.label)}</b> — ${esc(meta.sentence)}`;
  }

  // ── 선택/하이라이트 ──────────────────────────────────────
  function select(name) {
    S.selected = name;
    svg.classList.toggle('has-sel', !!name);
    const near = new Set(name ? [name] : []);
    if (name) {
      for (const e of edgeEls) {
        if (S.filter === 'real' && e.ref.kind === 'logical') continue;
        if (e.ref.child.table === name) near.add(e.ref.parent.table);
        if (e.ref.parent.table === name) near.add(e.ref.child.table);
      }
    }
    for (const tn in nodeEls) {
      nodeEls[tn].classList.toggle('sel', tn === name);
      nodeEls[tn].classList.toggle('dim', !!name && !near.has(tn));
    }
    for (const e of edgeEls) {
      const adj = !!name && (e.ref.child.table === name || e.ref.parent.table === name);
      e.el.classList.toggle('adj', adj);
      e.el.classList.toggle('dim', !!name && !adj);
    }
  }
  function applyHubToggles() {
    // 켜진 허브의 엣지만 hub-on — 허브별 독립 토글
    for (const e of edgeEls) {
      const hub = e.el.dataset.hub;
      if (hub) e.el.classList.toggle('hub-on', !!S.hubShown[hub]);
    }
  }
  function applyFilter() { svg.classList.toggle('filter-real', S.filter === 'real'); if (S.selected) select(S.selected); }

  // ── 미니맵 ──────────────────────────────────────────────
  const MM = { w: 176, h: 120, pad: 6 };
  let mmSvg = null, mmView = null, mmScale = 1, mmBox = null, mmRaf = 0;

  function scheduleMinimap() {
    if (mmRaf) return;
    mmRaf = requestAnimationFrame(() => { mmRaf = 0; buildMinimap(); });
  }

  function mountMinimap() {
    mmSvg = document.getElementById('minimap');
    if (!mmSvg) return;
    // 크기의 단일 출처는 MM 상수 — CSS에는 위치/외양만 둔다
    mmSvg.setAttribute('viewBox', `0 0 ${MM.w} ${MM.h}`);
    mmSvg.style.width = MM.w + 'px';
    mmSvg.style.height = MM.h + 'px';
    mmSvg.style.boxSizing = 'content-box';
    const jump = (e) => {
      const mr = mmSvg.getBoundingClientRect(), r = svg.getBoundingClientRect();
      const wx = (e.clientX - mr.left - mmSvg.clientLeft - MM.pad) / mmScale + mmBox.x;
      const wy = (e.clientY - mr.top - mmSvg.clientTop - MM.pad) / mmScale + mmBox.y;
      tf.x = r.width / 2 - wx * tf.k;
      tf.y = r.height / 2 - wy * tf.k;
      applyTf();
    };
    let dragging = false;
    mmSvg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !mmBox) return;
      dragging = true; mmSvg.setPointerCapture(e.pointerId); jump(e);
    });
    mmSvg.addEventListener('pointermove', (e) => { if (dragging) jump(e); });
    mmSvg.addEventListener('pointerup', () => { dragging = false; });
    mmSvg.addEventListener('pointercancel', () => { dragging = false; });
    mmSvg.addEventListener('lostpointercapture', () => { dragging = false; });
    window.addEventListener('resize', updateMinimapView);
  }
  function buildMinimap() {
    if (!mmSvg || !model) return;
    mmBox = contentBBox();
    if (!(mmBox.w > 0) || !(mmBox.h > 0)) { mmSvg.innerHTML = ''; mmView = null; mmBox = null; return; }
    mmScale = Math.min((MM.w - MM.pad * 2) / mmBox.w, (MM.h - MM.pad * 2) / mmBox.h);
    mmSvg.innerHTML = '';
    for (const t of model.tables) {
      const p = pos[t.name]; if (!p) continue;
      el('rect', {
        class: 'mm-node',
        x: MM.pad + (p.x - mmBox.x) * mmScale, y: MM.pad + (p.y - mmBox.y) * mmScale,
        width: Math.max(2, p.w * mmScale), height: Math.max(2, p.h * mmScale),
        style: `fill:var(${S.groupColor[t.group] || '--gc-x'})`,
      }, mmSvg);
    }
    mmView = el('rect', { class: 'mm-view', rx: 2 }, mmSvg);
    updateMinimapView();
  }
  function updateMinimapView() {
    if (!mmView || !mmBox) return;
    const r = svg.getBoundingClientRect();
    if (!r.width) return;
    mmView.setAttribute('x', MM.pad + (-tf.x / tf.k - mmBox.x) * mmScale);
    mmView.setAttribute('y', MM.pad + (-tf.y / tf.k - mmBox.y) * mmScale);
    mmView.setAttribute('width', (r.width / tf.k) * mmScale);
    mmView.setAttribute('height', (r.height / tf.k) * mmScale);
  }

  // ── 뷰포트 ──────────────────────────────────────────────
  function contentBBox() {
    let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
    for (const k in pos) {
      x1 = Math.min(x1, pos[k].x); y1 = Math.min(y1, pos[k].y);
      x2 = Math.max(x2, pos[k].x + pos[k].w); y2 = Math.max(y2, pos[k].y + pos[k].h);
    }
    return { x: x1 - 30, y: y1 - 50, w: x2 - x1 + 60, h: y2 - y1 + 80 };
  }
  function fit() {
    const b = contentBBox(), r = svg.getBoundingClientRect();
    if (b.w <= 0) return;
    if (!r.width || !r.height) { pendingFit = true; return; } // 숨겨진 상태(포커스 모드)에서 scale 0 방지
    pendingFit = false;
    const k = Math.min(r.width / b.w, r.height / b.h, 1);
    tf = { k, x: (r.width - b.w * k) / 2 - b.x * k, y: (r.height - b.h * k) / 2 - b.y * k };
    applyTf();
  }
  function fitIfPending() { if (pendingFit) fit(); else updateMinimapView(); } // 숨김 중 리사이즈로 스테일해진 미니맵 뷰포트 보정
  function centerOn(name) {
    const p = pos[name]; if (!p) return;
    const r = svg.getBoundingClientRect();
    tf.x = r.width / 2 - (p.x + p.w / 2) * tf.k;
    tf.y = r.height / 2 - (p.y + p.h / 2) * tf.k;
    applyTf();
  }

  function hookViewport() {
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const k2 = Math.min(2.5, Math.max(0.12, tf.k * Math.exp(-e.deltaY * 0.01)));
        const r = svg.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        tf.x = mx - ((mx - tf.x) / tf.k) * k2;
        tf.y = my - ((my - tf.y) / tf.k) * k2;
        tf.k = k2;
      } else { tf.x -= e.deltaX; tf.y -= e.deltaY; }
      applyTf();
    }, { passive: false });

    let drag = null;
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // 우클릭 드래그/선택 방지
      const nodeG = e.target.closest && e.target.closest('.node');
      const hullG = !nodeG && e.target.closest && e.target.closest('.hullg');
      if (nodeG) {
        const name = nodeG.dataset.name;
        const t = model.tables.find((x) => x.name === name);
        fastPreview = true; // 드래그 중엔 빠른 곡선 미리보기, 확정 시 전체 재라우팅
        drag = { type: 'node', name, group: t && t.group, sx: e.clientX, sy: e.clientY, ox: pos[name].x, oy: pos[name].y, moved: false };
      } else if (hullG) {
        // 그룹(헐) 드래그: 멤버 테이블 전체를 한 단위로 이동
        fastPreview = true;
        const gname = hullG.dataset.group;
        const members = model.tables.filter((t) => t.group === gname && pos[t.name]).map((t) => t.name);
        drag = {
          type: 'group', members, sx: e.clientX, sy: e.clientY, moved: false,
          orig: Object.fromEntries(members.map((m) => [m, { x: pos[m].x, y: pos[m].y }])),
          hullEls: [...hullG.querySelectorAll('rect,text')].map((n) => ({ n, x: +n.getAttribute('x'), y: +n.getAttribute('y') })),
        };
      } else if (!e.target.closest('.edge')) {
        drag = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: tf.x, oy: tf.y, moved: false };
        svg.classList.add('panning');
      }
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.type === 'pan') { tf.x = drag.ox + dx; tf.y = drag.oy + dy; applyTf(); }
      else if (drag.type === 'group') {
        const dxk = dx / tf.k, dyk = dy / tf.k;
        for (const m of drag.members) {
          pos[m].x = drag.orig[m].x + dxk; pos[m].y = drag.orig[m].y + dyk;
          nodeEls[m].setAttribute('transform', `translate(${pos[m].x},${pos[m].y})`);
        }
        for (const h of drag.hullEls) { h.n.setAttribute('x', h.x + dxk); h.n.setAttribute('y', h.y + dyk); }
        redrawEdgesTouchingSet(new Set(drag.members));
        scheduleMinimap();
      }
      else {
        const p = pos[drag.name];
        p.x = drag.ox + dx / tf.k; p.y = drag.oy + dy / tf.k;
        nodeEls[drag.name].setAttribute('transform', `translate(${p.x},${p.y})`);
        redrawEdgesTouching(drag.name);
        if (drag.group) updateHull(drag.group);
        scheduleMinimap();
      }
    });
    svg.addEventListener('pointerup', (e) => {
      if (!drag) return;
      if (drag.type === 'node') {
        if (!drag.moved) { fastPreview = false; cb.onSelect(drag.name === S.selected ? null : drag.name); }
        else { customLayout = true; savePositions(); settleAfterMove(); }
      } else if (drag.type === 'group') {
        if (!drag.moved) { fastPreview = false; cb.onSelect(null); }
        else { customLayout = true; savePositions(); settleAfterMove(); }
      } else if (drag.type === 'pan' && !drag.moved) cb.onSelect(null);
      svg.classList.remove('panning');
      drag = null;
    });
    svg.addEventListener('dblclick', (e) => {
      const nodeG = e.target.closest && e.target.closest('.node');
      if (nodeG) cb.onOpenFocus(nodeG.dataset.name);
    });
  }

  // ── 공개 API ────────────────────────────────────────────
  return {
    mount(svgEl, callbacks) { svg = svgEl; cb = callbacks; hookViewport(); mountMinimap(); },
    async load(m, s, state) {
      model = m; sem = s; S = state;
      await computeLayout();
      render();
      fit();
      applyFilter();
      if (S.selected) select(S.selected);
    },
    rerender() { render(); if (S.selected) select(S.selected); applyFilter(); },
    select, fit, fitIfPending, centerOn, applyFilter, applyHubToggles,
    async resetLayout() { if (!model) return; clearPositions(); await computeLayout(); render(); fit(); applyFilter(); if (S.selected) select(S.selected); },
    hasCustomLayout: () => customLayout,
  };
})();
