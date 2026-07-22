// 포커스 모드: 레퍼런스 탐색기의 3열(피참조|포커스|참조) 뷰를 범용 모델로 이식.
const Focus = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  let model, sem, S, cb;   // cb: {go}
  let childrenEdges = {}, parentsEdges = {};

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const byName = () => new Map(model.tables.map((t) => [t.name, t]));

  function neighbors(name) {
    const parents = {}, children = {}, self = [];
    for (const r of model.refs) {
      if (S.filter === 'real' && r.kind === 'logical') continue;
      if (r.child.table === name) {
        if (r.self) { self.push(r); continue; }
        (parents[r.parent.table] = parents[r.parent.table] || []).push(r);
      } else if (r.parent.table === name && !r.self) {
        (children[r.child.table] = children[r.child.table] || []).push(r);
      }
    }
    return { parents, children, self };
  }

  function junctionTag(other, focus) {
    const j = sem.junctions[other];
    if (j === undefined) return '';
    if (j === null) return 'N:M multi';
    const oe = j[0] === focus ? j[1] : j[1] === focus ? j[0] : '';
    return oe ? `N:M ↔ ${oe}` : 'N:M';
  }

  function relLine(r) {
    const m = sem.refMeta[r.id], ty = sem.TYPES[m.type];
    const lab = m.label === ty.label ? '' : `<b class="rm">${esc(m.label)}</b>`;
    return `<span title="${esc(m.sentence)}">${lab}<span class="ty" style="--c:var(${ty.cssVar})">${ty.label}</span><span class="cardchip">${m.card}</span><em>${esc(r.child.cols[0])}</em></span>`;
  }

  function nodeCard(other, edges) {
    const t = byName().get(other);
    const gv = S.groupColor[t && t.group] || '--gc-x';
    const elB = document.createElement('button');
    elB.className = 'fnode'; elB.dataset.name = other;
    elB.style.setProperty('--gc', `var(${gv})`);
    const jt = junctionTag(other, S.focusTable);
    // 조인테이블이면 반대편으로 바로 건너뛰는 링크 — 경유지 2클릭을 1클릭으로
    const j = sem.junctions[other];
    const far = Array.isArray(j) ? (j[0] === S.focusTable ? j[1] : j[1] === S.focusTable ? j[0] : '') : '';
    elB.innerHTML =
      `<span class="nname">${esc(other)}${jt ? `<span class="nm-tag">${esc(jt)}</span>` : ''}</span>` +
      `<span class="nmean">${esc((t && t.note) || '')}</span>` +
      `<span class="nrel">${edges.map(relLine).join('')}</span>` +
      (far && far !== other ? `<span class="fskip" role="button" tabindex="0">↔ ${esc(far)} 바로가기</span>` : '');
    elB.addEventListener('click', () => cb.go(other));
    elB.addEventListener('pointerenter', () => setHot(other, null, true));
    elB.addEventListener('pointerleave', () => setHot(null, null, false));
    const skip = elB.querySelector('.fskip');
    if (skip) skip.addEventListener('click', (e) => { e.stopPropagation(); cb.go(far); });
    return elB;
  }

  function focusCard(t) {
    const gv = S.groupColor[t.group] || '--gc-x';
    const div = document.createElement('div');
    div.className = 'ffocus'; div.style.setProperty('--gc', `var(${gv})`);
    const passesFilter = (r) => S.filter !== 'real' || r.kind === 'real';
    const selfRef = model.refs.find((r) => r.self && r.child.table === t.name && passesFilter(r));
    let rows = '';
    for (const c of t.cols) {
      const nullable = !c.pk && !c.notNull;
      let b = '';
      if (c.pk) b += '<span class="badge pk">PK</span>';
      if (c.unique) b += '<span class="badge uq">UQ</span>';
      // 이 컬럼이 선두인 ref를 우선, 없으면 복합 FK의 후행 멤버 여부 확인
      const ref = model.refs.find((r) => r.child.table === t.name && r.child.cols[0] === c.name && passesFilter(r));
      const memberRef = !ref && model.refs.find((r) => r.child.table === t.name && r.child.cols.includes(c.name) && passesFilter(r));
      let cell;
      if (ref) {
        const m = sem.refMeta[ref.id], ty = sem.TYPES[m.type];
        const tychip = `<span class="ty" style="--c:var(${ty.cssVar})">${ty.label}</span>`;
        if (ref.self) cell = `<span class="fkcell">${tychip}<span class="fk self">⟲ ${esc(m.label)}</span></span>`;
        else {
          const fkm = m.label === ty.label ? '' : `<span class="fkm">${esc(m.label)}</span>`;
          cell = `<span class="fkcell" title="${esc(m.sentence)}">${fkm}${tychip}<span class="cardchip">${m.card}</span>` +
            `<a class="fk ${ref.kind}" data-goto="${esc(ref.parent.table)}" title="${ref.kind === 'real' ? '실제 DB FK' : '논리 FK'} → ${esc(ref.parent.table)}">→ ${esc(ref.parent.table)}.${esc(ref.parent.cols[0])}</a></span>`;
        }
      } else if (memberRef) {
        cell = `<span class="fkcell" title="복합 FK (${esc(memberRef.child.cols.join(', '))}) → ${esc(memberRef.parent.table)}">` +
          `<a class="fk ${memberRef.kind}" data-goto="${esc(memberRef.parent.table)}">↪ 복합 FK → ${esc(memberRef.parent.table)}</a></span>`;
      } else {
        cell = `<span class="ct">${esc(c.type)}${nullable ? '?' : ''}</span>`;
      }
      rows += `<div class="col-row ${nullable ? 'nullable' : ''}" data-col="${esc(c.name)}"><span class="b">${b}</span><span class="cn">${esc(c.name)}</span>${cell}</div>`;
    }
    const nb = neighbors(t.name);
    const nc = Object.keys(nb.children).length, np = Object.keys(nb.parents).length;
    const j = sem.junctions[t.name];
    const jb = j !== undefined ? `<span class="f-nm">${j === null ? 'N:M multi 링크' : `N:M 연결 · ${esc(j[0])} ↔ ${esc(j[1])}`}</span>` : '';
    div.innerHTML =
      `<div class="f-head"><div class="f-top"><span class="f-dot"></span><span class="f-name">${esc(t.name)}</span>` +
      `${selfRef ? '<span class="f-self">⟲ self-ref</span>' : ''}${jb}</div>` +
      `<div class="f-note">${esc(t.note || '')}</div></div>` +
      `<div class="f-cols">${rows}</div>` +
      `<div class="f-foot"><span>피참조 <b>${nc}</b></span><span>참조 <b>${np}</b></span><span>컬럼 <b>${t.cols.length}</b></span></div>`;
    div.querySelectorAll('.fk[data-goto]').forEach((a) =>
      a.addEventListener('click', (e) => { e.stopPropagation(); cb.go(a.dataset.goto); }));
    // FK 행 hover → 대응 와이어·이웃 카드 하이라이트
    div.querySelectorAll('.col-row').forEach((row) => {
      const col = row.dataset.col;
      if (!model.refs.some((r) => r.child.table === t.name && r.child.cols[0] === col && !r.self)) return;
      row.addEventListener('pointerenter', () => setHot(null, col, true));
      row.addEventListener('pointerleave', () => setHot(null, null, false));
    });
    return div;
  }

  function pt(elm, stRect) {
    const r = elm.getBoundingClientRect();
    return { l: r.left - stRect.left, t: r.top - stRect.top, r: r.right - stRect.left, b: r.bottom - stRect.top, cy: (r.top + r.bottom) / 2 - stRect.top };
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // 와이어↔포커스 컬럼 행↔이웃 카드 상호 하이라이트
  function setHot(other, col, on) {
    const wires = $('fwires');
    wires.classList.toggle('dim', on);
    wires.querySelectorAll('g.fw').forEach((g) => {
      g.classList.toggle('hot', on && (!other || g.dataset.other === other) && (!col || g.dataset.col === col));
    });
    document.querySelectorAll('#focuswrap .fnode.hot').forEach((n) => n.classList.remove('hot'));
    if (on && other) {
      const n = document.querySelector(`#focuswrap .fnode[data-name="${CSS.escape(other)}"]`);
      if (n) n.classList.add('hot');
    }
    const fe = $('fcolM').querySelector('.ffocus');
    if (fe) {
      fe.querySelectorAll('.col-row.hot').forEach((r2) => r2.classList.remove('hot'));
      if (on && col) {
        const r2 = fe.querySelector(`.col-row[data-col="${CSS.escape(col)}"]`);
        if (r2) r2.classList.add('hot');
      }
    }
  }

  function drawWires() {
    const stage = $('fstage'), wires = $('fwires');
    wires.innerHTML = '';
    wires.classList.remove('dim');
    wires.setAttribute('width', stage.scrollWidth);
    wires.setAttribute('height', stage.scrollHeight);
    const focusEl = $('fcolM').querySelector('.ffocus');
    if (!focusEl) return;
    const st = stage.getBoundingClientRect();
    const F = pt(focusEl, st);
    const fcolsEl = focusEl.querySelector('.f-cols');
    const FC = fcolsEl ? pt(fcolsEl, st) : F;
    const rowY = (colName) => {
      const row = colName && focusEl.querySelector(`.col-row[data-col="${CSS.escape(colName)}"]`);
      return row ? clamp(pt(row, st).cy, FC.t + 6, FC.b - 6) : null;
    };
    const mkNS = (tag, attrs) => {
      const e = document.createElementNS(NS, tag);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    };
    // 관계(엣지) 하나 = 와이어 하나. 색·점선은 그 엣지의 유형·kind를 그대로 따른다.
    const mk = (a, b2, ay, by, ref, info) => {
      const m = sem.refMeta[ref.id], cvar = sem.TYPES[m.type].cssVar;
      const g = mkNS('g', { class: 'fw' });
      g.dataset.other = info.other; g.dataset.col = info.col || '';
      const dx = Math.max(50, Math.abs(b2 - a) * 0.5);
      const d = `M${a},${ay} C${a + dx},${ay} ${b2 - dx},${by} ${b2},${by}`;
      const p = mkNS('path', { d, class: 'w', 'stroke-width': '2.4', 'stroke-linecap': 'round' });
      p.style.stroke = `var(${cvar})`;
      if (ref.kind === 'logical') p.setAttribute('stroke-dasharray', '6 4');
      g.appendChild(p);
      const arr = mkNS('path', { d: `M${b2},${by} l-8,-3.6 v7.2 Z` });
      arr.style.fill = `var(${cvar})`;
      g.appendChild(arr);
      const dot = mkNS('circle', { cx: a, cy: ay, r: '3.4' });
      dot.style.fill = `var(${cvar})`;
      g.appendChild(dot);
      const hit = mkNS('path', { d, class: 'hit' });
      hit.addEventListener('pointerenter', (e) => {
        setHot(info.other, info.col, true);
        if (cb.tooltip) cb.tooltip.show(`<b>${esc(m.label)}</b> — ${esc(m.sentence)}`, e.clientX, e.clientY);
      });
      hit.addEventListener('pointermove', (e) => { if (cb.tooltip) cb.tooltip.move(e.clientX, e.clientY); });
      hit.addEventListener('pointerleave', () => { setHot(null, null, false); if (cb.tooltip) cb.tooltip.hide(); });
      g.appendChild(hit);
      wires.appendChild(g);
    };
    // 좌열(피참조): 카드당 1선 — 포커스 카드의 피참조 컬럼 행(대개 id)으로 팬인
    $('fcolL').querySelectorAll('.fnode').forEach((nd) => {
      if (!nd.offsetParent) return; // 접힌 카드 스킵
      const name = nd.dataset.name, edges = childrenEdges[name] || [];
      if (!edges.length) return;
      const b = pt(nd, st);
      const rep = edges.find((e) => e.kind === 'real') || edges[0];
      const ay = rowY(rep.parent.cols[0]);
      mk(b.r, F.l, b.cy, ay != null ? ay : clamp(b.cy, F.t + 12, F.b - 12), rep, { other: name, col: '' });
    });
    // 우열(참조): 엣지당 1선 — 포커스 카드의 실제 FK 컬럼 행에서 출발, 같은 카드 도착은 스프레드
    $('fcolR').querySelectorAll('.fnode').forEach((nd) => {
      if (!nd.offsetParent) return;
      const name = nd.dataset.name, edges = parentsEdges[name] || [];
      const b = pt(nd, st);
      edges.forEach((edge, i) => {
        const sy = rowY(edge.child.cols[0]);
        const by = b.cy + (i - (edges.length - 1) / 2) * 12;
        mk(F.r, b.l, sy != null ? sy : clamp(b.cy, F.t + 12, F.b - 12), by, edge, { other: name, col: edge.child.cols[0] });
      });
    });
  }

  function render(name) {
    const t = byName().get(name);
    const L = $('fcolL'), M = $('fcolM'), R = $('fcolR');
    L.innerHTML = ''; M.innerHTML = ''; R.innerHTML = '';
    if (!t) {
      // 미존재 테이블 — 낡은 뷰를 남기지 않고 정리
      $('fwires').innerHTML = '';
      $('cnt-l').textContent = 0; $('cnt-r').textContent = 0;
      $('fguide').innerHTML = `<b class="fn">「${esc(name || '')}」</b> — 존재하지 않는 테이블입니다`;
      return;
    }
    S.focusTable = name;
    const nb = neighbors(name);
    childrenEdges = nb.children; parentsEdges = nb.parents;
    const ck = Object.keys(nb.children).sort(), pk = Object.keys(nb.parents).sort();
    // 좌열: 관계 유형 순 섹션 + 색 헤더, 섹션당 6개 초과분은 접기
    const TYPE_ORDER = Object.keys(sem.TYPES);
    const fillLeft = (colEl, map) => {
      const list = Object.keys(map).map((o) => ({
        other: o, edges: map[o],
        ti: Math.max(0, TYPE_ORDER.indexOf(sem.refMeta[map[o][0].id].type)),
      })).sort((a, b) => a.ti - b.ti || b.edges.length - a.edges.length || a.other.localeCompare(b.other));
      if (!list.length) { colEl.innerHTML = '<div class="empty">— 없음 —</div>'; return; }
      const sections = [];
      for (const it of list) {
        if (!sections.length || sections[sections.length - 1].ti !== it.ti) sections.push({ ti: it.ti, items: [] });
        sections[sections.length - 1].items.push(it);
      }
      for (const sec of sections) {
        const ty = sem.TYPES[TYPE_ORDER[sec.ti]];
        const hd = document.createElement('div');
        hd.className = 'f-typehead';
        hd.innerHTML = `<span class="ty" style="--c:var(${ty.cssVar})">${ty.label}</span>` +
          `<span class="cnt">${sec.items.length}</span>`;
        colEl.appendChild(hd);
        const fold = sec.items.length > 6;
        const hiddenCards = [];
        sec.items.forEach((it, i) => {
          const card = nodeCard(it.other, it.edges);
          if (fold && i >= 5) { card.classList.add('fmore-hidden'); hiddenCards.push(card); }
          colEl.appendChild(card);
        });
        if (fold) {
          const btn = document.createElement('button');
          btn.className = 'fmore';
          btn.textContent = `+ ${sec.items.length - 5}개 더 보기`;
          btn.addEventListener('click', () => {
            hiddenCards.forEach((c) => c.classList.remove('fmore-hidden'));
            btn.remove();
            drawWires();
          });
          colEl.appendChild(btn);
        }
      }
    };
    // 우열: 포커스 카드의 FK 컬럼 행 순서로 정렬 — 행 정박 와이어가 교차하지 않게
    const colIdx = new Map(t.cols.map((c, i) => [c.name, i]));
    const fillRight = (colEl, map) => {
      const list = Object.keys(map).map((o) => ({
        other: o, edges: map[o],
        ri: Math.min(...map[o].map((r) => { const i = colIdx.get(r.child.cols[0]); return i == null ? 999 : i; })),
      })).sort((a, b) => a.ri - b.ri || a.other.localeCompare(b.other));
      if (!list.length) { colEl.innerHTML = '<div class="empty">— 없음 —</div>'; return; }
      for (const it of list) colEl.appendChild(nodeCard(it.other, it.edges));
    };
    fillLeft(L, nb.children);
    M.appendChild(focusCard(t));
    fillRight(R, nb.parents);
    $('cnt-l').textContent = ck.length; $('cnt-r').textContent = pk.length;

    const short = (s) => (s.startsWith(name + '_') ? s.slice(name.length + 1) : s);
    const exL = ck.slice(0, 4).map(short).join(' · ') + (ck.length > 4 ? ' …' : '');
    const pmeans = [];
    pk.forEach((o) => nb.parents[o].forEach((r) => {
      const m = sem.refMeta[r.id].label;
      if (m && !pmeans.includes(m)) pmeans.push(m);
    }));
    const exR = pmeans.slice(0, 4).join(' · ') + (pmeans.length > 4 ? ' …' : '');
    $('fguide').innerHTML = (ck.length || pk.length)
      ? `<b class="fn">「${esc(name)}」</b> 하나를 놓고 보면 — <span class="gtag l">◀ 딸린 하위 ${ck.length}</span> <span class="gex">${esc(exL) || '없음'}</span> &nbsp; <span class="gtag r">가리키는 상위 ${pk.length} ▶</span> <span class="gex">${esc(exR) || '없음'}</span>`
      : `<b class="fn">「${esc(name)}」</b> — 연결된 관계가 없습니다`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      drawWires();
      // 포커스 카드 컬럼 스크롤 시 행 정박 와이어 재계산
      const fc = M.querySelector('.f-cols');
      if (fc) {
        let raf = 0;
        fc.addEventListener('scroll', () => {
          if (!raf) raf = requestAnimationFrame(() => { raf = 0; drawWires(); });
        });
      }
      // 딸린 것이 많아 스테이지가 길어져도 포커스 카드가 화면에 오도록
      const f = M.querySelector('.ffocus');
      if (f) f.scrollIntoView({ block: 'center' });
    }));
  }

  return {
    init(m, s, state, callbacks) { model = m; sem = s; S = state; cb = callbacks; },
    render, drawWires,
  };
})();
