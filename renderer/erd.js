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
        layoutOptions: { 'elk.padding': '[top=42,left=18,bottom=18,right=18]' },
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
        'elk.layered.spacing.nodeNodeBetweenLayers': '80',
        'elk.spacing.nodeNode': '32',
        'elk.spacing.componentComponent': '72',
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
  function applyTf() { vp.setAttribute('transform', `translate(${tf.x},${tf.y}) scale(${tf.k})`); }

  function render() {
    if (cb && cb.tooltip) cb.tooltip.hide(); // 재렌더 시 툴팁 고착 방지
    svg.innerHTML = '';
    vp = el('g', { id: 'vp' }, svg);
    const hullLayer = el('g', {}, vp);
    const edgeLayer = el('g', {}, vp);
    const nodeLayer = el('g', {}, vp);
    edgeEls = []; nodeEls = {};

    // 그룹 헐
    for (const g of model.groups) {
      const members = model.tables.filter((t) => t.group === g.name && pos[t.name]);
      if (!members.length) continue;
      const xs = members.map((t) => pos[t.name].x), ys = members.map((t) => pos[t.name].y);
      const x2 = Math.max(...members.map((t) => pos[t.name].x + pos[t.name].w));
      const y2 = Math.max(...members.map((t) => pos[t.name].y + pos[t.name].h));
      const x = Math.min(...xs) - 16, y = Math.min(...ys) - 38;
      const gv = S.groupColor[g.name] || '--gc-x';
      const hg = el('g', { class: 'hullg', style: `--gc:var(${gv})` }, hullLayer);
      hg.dataset.group = g.name;
      el('rect', { class: 'hull', x, y, width: x2 + 16 - x, height: y2 + 14 - y, rx: 14 }, hg);
      const lab = el('text', { class: 'hull-label', x: x + 13, y: y + 19 }, hg);
      lab.textContent = `${g.name}  · ${members.length}`;
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

  function setHubHot(child, hub, on) {
    for (const e of edgeEls) {
      if (e.ref.child.table === child && e.ref.parent.table === hub)
        e.el.classList.toggle('hot', on);
    }
  }

  // ── 엣지 지오메트리 ──────────────────────────────────────
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
      const dx = Math.max(46, Math.abs(px - cx) * 0.42);
      const c1 = parentRight ? cx + dx : cx - dx;
      const c2 = parentRight ? px - dx : px + dx;
      d = `M${cx},${cy} C${c1},${cy} ${c2},${py} ${px},${py}`;
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
  function fitIfPending() { if (pendingFit) fit(); }
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
        drag = { type: 'node', name, sx: e.clientX, sy: e.clientY, ox: pos[name].x, oy: pos[name].y, moved: false };
      } else if (hullG) {
        // 그룹(헐) 드래그: 멤버 테이블 전체를 한 단위로 이동
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
      }
      else {
        const p = pos[drag.name];
        p.x = drag.ox + dx / tf.k; p.y = drag.oy + dy / tf.k;
        nodeEls[drag.name].setAttribute('transform', `translate(${p.x},${p.y})`);
        redrawEdgesTouching(drag.name);
      }
    });
    svg.addEventListener('pointerup', (e) => {
      if (!drag) return;
      if (drag.type === 'node') {
        if (!drag.moved) { cb.onSelect(drag.name === S.selected ? null : drag.name); }
        else { customLayout = true; savePositions(); if (S.selected) select(S.selected); }
      } else if (drag.type === 'group') {
        if (!drag.moved) cb.onSelect(null);
        else { customLayout = true; savePositions(); if (S.selected) select(S.selected); }
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
    mount(svgEl, callbacks) { svg = svgEl; cb = callbacks; hookViewport(); },
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
