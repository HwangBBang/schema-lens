// 변경 비교 뷰 — 마지막 커밋 시점의 스키마와 지금 파일을 좌우로 나란히 그린다.
//
// 읽기 전용이다. 드래그로 카드 옮기기·미니맵·허브 접기·정렬 방식은 없다. 확대와 이동만 되고
// 그 상태는 양쪽이 공유한다(따로 놀면 비교가 안 된다).
//
// 배치는 두 리비전을 합친 집합으로 한 번만 계산해 양쪽에 같은 좌표를 쓴다. 같은 테이블이
// 같은 자리에 있어야 눈이 좌우를 맞대어 볼 수 있기 때문이다. 박스 크기도 양쪽 중 큰 쪽으로
// 통일한다 — 한쪽만 크면 좌표가 같아도 이웃과 겹친다.
//
// 관계선은 배치 엔진(elk)이 함께 내주는 꺾임점을 그대로 쓴다. 전체 ERD의 격자 우회 라우팅을
// 복제하지 않으려는 선택이다(한쪽만 고쳐지는 사고를 막는다).
window.Compare = (function () {
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const el = (n, a) => {
    const e = document.createElementNS(NS, n);
    for (const k in a || {}) e.setAttribute(k, a[k]);
    return e;
  };
  const W = 208, HDR = 26, ROW = 17, PADB = 8, MAXROWS = 12;

  let S = null;
  let diff = null, before = null, after = null;
  let pos = {}, edgePts = {};
  const tf = { x: 0, y: 0, k: 1 };
  let bounds = { w: 1, h: 1 };

  function init(state) { S = state; }

  // ── 표시할 컬럼 고르기 ─────────────────────────────────────
  // 키(PK/FK/UNIQUE)는 늘 보여주고, 바뀐 컬럼은 '키만' 규칙에 걸려 숨겨지더라도 끌어올린다.
  // 변경을 색으로 보여주기로 한 화면에서 정작 바뀐 줄이 접혀 있으면 아무 의미가 없다.
  function fkCols(model) {
    const m = {};
    for (const r of model.refs || []) {
      (m[r.child.table] = m[r.child.table] || new Set()).add(r.child.cols[0]);
    }
    return m;
  }
  function keepNames(model, name, fks) {
    const t = (model.tables || []).find((x) => x.name === name);
    if (!t) return null;
    const td = diff.tables[name] || { cols: {} };
    const fk = fks[name] || new Set();
    const keep = t.cols.filter((c) =>
      c.pk || c.unique || fk.has(c.name) || (td.cols[c.name] && td.cols[c.name].status !== 'same'));
    return { table: t, names: (keep.length ? keep : t.cols.slice(0, 3)).map((c) => c.name) };
  }
  // 좌우가 같은 줄 구성을 갖도록 표시 컬럼을 합집합으로 맞춘다. 한쪽에서만 키였던 컬럼이
  // 반대쪽에서 접히면 같은 테이블인데 줄이 달라 보여, 정작 비교가 안 된다.
  function rowsOf(k, pick) {
    if (!k) return null;
    const shown = k.table.cols.filter((c) => pick.has(c.name)).slice(0, MAXROWS);
    return { table: k.table, shown, hidden: k.table.cols.length - shown.length };
  }

  // ── 배치 ───────────────────────────────────────────────────
  async function computeLayout() {
    const fkB = fkCols(before), fkA = fkCols(after);
    const names = new Set([...before.tables.map((t) => t.name), ...after.tables.map((t) => t.name)]);
    const rows = {}, size = {};
    for (const n of names) {
      const kb = keepNames(before, n, fkB), ka = keepNames(after, n, fkA);
      const pick = new Set([...(kb ? kb.names : []), ...(ka ? ka.names : [])]);
      const b = rowsOf(kb, pick), a = rowsOf(ka, pick);
      rows[n] = { before: b, after: a };
      const lines = Math.max(b ? b.shown.length + (b.hidden > 0 ? 1 : 0) : 0,
                             a ? a.shown.length + (a.hidden > 0 ? 1 : 0) : 0);
      size[n] = { w: W, h: HDR + 4 + lines * ROW + PADB };
    }

    const seen = new Set();
    const edges = [];
    for (const r of [...before.refs, ...after.refs]) {
      if (seen.has(r.id) || r.self) continue;
      if (!names.has(r.child.table) || !names.has(r.parent.table)) continue;
      seen.add(r.id);
      edges.push({ id: r.id, sources: [r.child.table], targets: [r.parent.table] });
    }

    const res = await new ELK().layout({
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.edgeRouting': 'ORTHOGONAL',
        'elk.layered.spacing.nodeNodeBetweenLayers': '104',
        'elk.spacing.nodeNode': '56',
        'elk.spacing.componentComponent': '88',
      },
      children: [...names].map((n) => ({ id: n, width: size[n].w, height: size[n].h })),
      edges,
    });

    pos = {}; edgePts = {};
    let mx = 1, my = 1;
    for (const c of res.children || []) {
      pos[c.id] = { x: c.x, y: c.y, w: c.width, h: c.height };
      mx = Math.max(mx, c.x + c.width); my = Math.max(my, c.y + c.height);
    }
    for (const e of res.edges || []) {
      const s = (e.sections || [])[0];
      if (!s) continue;
      edgePts[e.id] = [s.startPoint, ...(s.bendPoints || []), s.endPoint];
    }
    bounds = { w: mx, h: my };
    return rows;
  }

  // ── 그리기 ─────────────────────────────────────────────────
  function pathOf(pts) {
    const R = 8;
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i], a = pts[i - 1], b = pts[i + 1];
      const r1 = Math.min(R, Math.hypot(p.x - a.x, p.y - a.y) / 2);
      const r2 = Math.min(R, Math.hypot(b.x - p.x, b.y - p.y) / 2);
      const i1 = { x: p.x + Math.sign(a.x - p.x) * r1, y: p.y + Math.sign(a.y - p.y) * r1 };
      const i2 = { x: p.x + Math.sign(b.x - p.x) * r2, y: p.y + Math.sign(b.y - p.y) * r2 };
      d += `L${i1.x},${i1.y}Q${p.x},${p.y} ${i2.x},${i2.y}`;
    }
    const last = pts[pts.length - 1];
    return d + `L${last.x},${last.y}`;
  }

  const REASON_LABEL = {
    type: '타입', notNull: 'NOT NULL', pk: 'PK', unique: 'UNIQUE', dflt: '기본값', note: '설명',
    cols: '컬럼', group: '그룹', pkCols: 'PK 구성', uniqueIndexes: '유니크 인덱스',
    kind: '실/논리 FK', onDelete: '삭제 동작', onUpdate: '갱신 동작',
    oneToOne: '1:1 여부', manyToMany: 'N:M 여부',
  };
  const labelOf = (reasons) => (reasons || []).map((r) => REASON_LABEL[r] || r).join(', ');

  function nodeEl(name, row, side) {
    const p = pos[name];
    const td = diff.tables[name] || { status: 'same', reasons: [], cols: {} };
    const g = el('g', { class: `cnode s-${td.status}`, transform: `translate(${p.x},${p.y})` });
    g.appendChild(el('rect', { class: 'cbox', x: 0, y: 0, width: p.w, height: p.h, rx: 9 }));
    g.appendChild(el('rect', { class: 'chdr', x: 0, y: 0, width: p.w, height: HDR, rx: 9 }));
    g.appendChild(el('rect', { class: 'chdr-b', x: 0, y: HDR - 9, width: p.w, height: 9 })); // 헤더 아래쪽 둥근 모서리 메우기
    const nm = el('text', { class: 'cname', x: 10, y: 17 });
    nm.textContent = name;
    g.appendChild(nm);

    const tip = el('title');
    tip.textContent = td.status === 'added' ? `${name} — 새로 생김`
      : td.status === 'removed' ? `${name} — 없어짐`
      : td.status === 'changed' ? `${name} — 바뀜 (${labelOf(td.reasons)})`
      : name;
    g.appendChild(tip);

    let y = HDR + 4 + 12;
    for (const c of row.shown) {
      const cd = td.cols[c.name] || { status: 'same' };
      const t = el('text', { class: `crow c-${cd.status}`, x: 10, y });
      t.textContent = (c.pk ? '● ' : '') + c.name;
      const ty = el('text', { class: 'ctype', x: p.w - 10, y, 'text-anchor': 'end' });
      ty.textContent = c.type || '';
      if (cd.status !== 'same') {
        const ct = el('title');
        ct.textContent = cd.status === 'added' ? `${c.name} — 추가됨`
          : cd.status === 'removed' ? `${c.name} — 삭제됨`
          : `${c.name} — ${labelOf(cd.reasons)} 바뀜`;
        t.appendChild(ct);
      }
      g.appendChild(t); g.appendChild(ty);
      y += ROW;
    }
    if (row.hidden > 0) {
      const m = el('text', { class: 'cmore', x: 10, y });
      m.textContent = `… ${row.hidden}개 더`;
      g.appendChild(m);
    }
    g.dataset.side = side;
    return g;
  }

  function drawPane(svg, model, rows, side) {
    svg.innerHTML = '';
    const vp = el('g', { class: 'cvp' });
    const edgeG = el('g', { class: 'cedges' });
    const nodeG = el('g');
    vp.appendChild(edgeG); vp.appendChild(nodeG);
    svg.appendChild(vp);

    for (const r of model.refs) {
      const pts = edgePts[r.id];
      if (!pts) continue;
      const st = (diff.refs[r.id] || { status: 'same' }).status;
      const p = el('path', { class: `cedge e-${st}${r.kind === 'logical' ? ' logical' : ''}`, d: pathOf(pts) });
      const tip = el('title');
      tip.textContent = st === 'added' ? `${r.id} — 새 관계`
        : st === 'removed' ? `${r.id} — 끊긴 관계`
        : st === 'changed' ? `${r.id} — ${labelOf(diff.refs[r.id].reasons)} 바뀜`
        : r.id;
      p.appendChild(tip);
      edgeG.appendChild(p);
    }
    for (const t of model.tables) {
      const row = rows[t.name] && rows[t.name][side];
      if (!row) continue;
      nodeG.appendChild(nodeEl(t.name, row, side));
    }
    return vp;
  }

  // ── 확대·이동(양쪽 공유) ────────────────────────────────────
  let vps = [];
  function applyTf() {
    for (const vp of vps) vp.setAttribute('transform', `translate(${tf.x},${tf.y}) scale(${tf.k})`);
  }
  function fit() {
    const box = $('cmp-l').getBoundingClientRect();
    const k = Math.min((box.width - 40) / bounds.w, (box.height - 40) / bounds.h, 1);
    tf.k = k > 0 ? k : 1;
    tf.x = (box.width - bounds.w * tf.k) / 2;
    tf.y = Math.max(20, (box.height - bounds.h * tf.k) / 2);
    applyTf();
  }
  function bindPanZoom() {
    for (const id of ['cmp-l', 'cmp-r']) {
      const svg = $(id);
      svg.onwheel = (e) => {
        e.preventDefault();
        const r = svg.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        const k = Math.max(0.15, Math.min(2.5, tf.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
        tf.x = mx - (mx - tf.x) * (k / tf.k);
        tf.y = my - (my - tf.y) * (k / tf.k);
        tf.k = k;
        applyTf();
      };
      svg.onpointerdown = (e) => {
        if (e.button !== 0) return;
        svg.setPointerCapture(e.pointerId);
        const sx = e.clientX - tf.x, sy = e.clientY - tf.y;
        svg.onpointermove = (m) => { tf.x = m.clientX - sx; tf.y = m.clientY - sy; applyTf(); };
        svg.onpointerup = () => { svg.onpointermove = null; svg.onpointerup = null; };
      };
    }
  }

  // ── 진입 ───────────────────────────────────────────────────
  function showEmpty(msg) {
    $('cmp-empty').hidden = false;
    $('cmp-empty').textContent = msg;
    $('cmp-body').hidden = true;
    $('cmp-sum').textContent = '';
    $('cmp-lft').textContent = '기준본 없음';
  }

  const whenText = (iso) => {
    if (!iso) return '';
    const d0 = new Date(iso), now = new Date();
    const days = Math.floor((now - d0) / 86400000);
    if (days <= 0) return '오늘';
    if (days === 1) return '어제';
    if (days < 30) return `${days}일 전`;
    return d0.toLocaleDateString('ko-KR');
  };

  async function render() {
    const r = await window.dbv.gitBaseline();
    if (r.error) { showEmpty(r.message); return false; }
    before = r.model; after = S.model;
    diff = SchemaDiff.diffModels(before, after);

    $('cmp-empty').hidden = true;
    $('cmp-body').hidden = false;
    $('cmp-lft').textContent = [whenText(r.when), r.sha, r.subject].filter(Boolean).join(' · ');

    const s = diff.summary;
    const chip = (n, cls, lab) => (n ? `<b class="${cls}">${lab} ${n}</b>` : '');
    const parts = [
      chip(s.tables.added, 'd-add', '테이블 추가'),
      chip(s.tables.removed, 'd-del', '테이블 삭제'),
      chip(s.tables.changed, 'd-chg', '테이블 변경'),
      chip(s.refs.added, 'd-add', '관계 추가'),
      chip(s.refs.removed, 'd-del', '관계 삭제'),
      chip(s.refs.changed, 'd-chg', '관계 변경'),
    ].filter(Boolean);
    $('cmp-sum').innerHTML = parts.length
      ? parts.join('<span class="sep">·</span>')
      : '마지막 커밋과 달라진 곳이 없습니다';

    const rows = await computeLayout();
    vps = [drawPane($('cmp-l'), before, rows, 'before'), drawPane($('cmp-r'), after, rows, 'after')];
    bindPanZoom();
    fit();
    return true;
  }

  return { init, render, fit, hasDiff: () => !!diff };
})();
