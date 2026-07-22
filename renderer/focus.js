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
    elB.innerHTML =
      `<span class="nname">${esc(other)}${jt ? `<span class="nm-tag">${esc(jt)}</span>` : ''}</span>` +
      `<span class="nmean">${esc((t && t.note) || '')}</span>` +
      `<span class="nrel">${edges.map(relLine).join('')}</span>`;
    elB.addEventListener('click', () => cb.go(other));
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
            `<a class="fk ${ref.kind}" title="${ref.kind === 'real' ? '실제 DB FK' : '논리 FK'} → ${esc(ref.parent.table)}">→ ${esc(ref.parent.table)}</a></span>`;
        }
      } else if (memberRef) {
        cell = `<span class="fkcell" title="복합 FK (${esc(memberRef.child.cols.join(', '))}) → ${esc(memberRef.parent.table)}">` +
          `<a class="fk ${memberRef.kind}">↪ 복합 FK → ${esc(memberRef.parent.table)}</a></span>`;
      } else {
        cell = `<span class="ct">${esc(c.type)}${nullable ? '?' : ''}</span>`;
      }
      rows += `<div class="col-row ${nullable ? 'nullable' : ''}"><span class="b">${b}</span><span class="cn">${esc(c.name)}</span>${cell}</div>`;
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
    // 이동 대상은 textContent(디코딩된 원래 이름)에서 복원 — 특수문자 이름도 안전
    const anchors = div.querySelectorAll('.fk:not(.self)');
    anchors.forEach((a) => {
      const m = (a.textContent.match(/→ (.+)$/) || [])[1];
      if (m) a.addEventListener('click', (e) => { e.stopPropagation(); cb.go(m); });
    });
    return div;
  }

  function pt(elm, stRect) {
    const r = elm.getBoundingClientRect();
    return { l: r.left - stRect.left, t: r.top - stRect.top, r: r.right - stRect.left, b: r.bottom - stRect.top, cy: (r.top + r.bottom) / 2 - stRect.top };
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function drawWires() {
    const stage = $('fstage'), wires = $('fwires');
    wires.innerHTML = '';
    wires.setAttribute('width', stage.scrollWidth);
    wires.setAttribute('height', stage.scrollHeight);
    const focusEl = $('fcolM').querySelector('.ffocus');
    if (!focusEl) return;
    const st = stage.getBoundingClientRect();
    const F = pt(focusEl, st);
    const mk = (a, b, ay, by, kind, cvar) => {
      const dx = Math.max(50, Math.abs(b - a) * 0.5);
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', `M${a},${ay} C${a + dx},${ay} ${b - dx},${by} ${b},${by}`);
      p.style.stroke = `var(${cvar})`;
      p.setAttribute('stroke-width', '2.4');
      if (kind === 'logical') p.setAttribute('stroke-dasharray', '6 4');
      p.setAttribute('stroke-linecap', 'round');
      wires.appendChild(p);
      const arr = document.createElementNS(NS, 'path');
      arr.setAttribute('d', `M${b},${by} l-8,-3.6 v7.2 Z`);
      arr.style.fill = `var(${cvar})`;
      wires.appendChild(arr);
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', a); dot.setAttribute('cy', ay); dot.setAttribute('r', '3.4');
      dot.style.fill = `var(${cvar})`;
      wires.appendChild(dot);
    };
    const cvarOf = (edges) => sem.TYPES[sem.refMeta[edges[0].id].type].cssVar;
    const kindOf = (edges) => (edges.some((e) => e.kind === 'real') ? 'real' : 'logical');
    $('fcolL').querySelectorAll('.fnode').forEach((nd) => {
      const b = pt(nd, st), edges = childrenEdges[nd.dataset.name];
      mk(b.r, F.l, b.cy, clamp(b.cy, F.t + 12, F.b - 12), kindOf(edges), cvarOf(edges));
    });
    $('fcolR').querySelectorAll('.fnode').forEach((nd) => {
      const b = pt(nd, st), edges = parentsEdges[nd.dataset.name];
      mk(F.r, b.l, clamp(b.cy, F.t + 12, F.b - 12), b.cy, kindOf(edges), cvarOf(edges));
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
    if (ck.length) ck.forEach((o) => L.appendChild(nodeCard(o, nb.children[o])));
    else L.innerHTML = '<div class="empty">— 없음 —</div>';
    M.appendChild(focusCard(t));
    if (pk.length) pk.forEach((o) => R.appendChild(nodeCard(o, nb.parents[o])));
    else R.innerHTML = '<div class="empty">— 없음 —</div>';
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
