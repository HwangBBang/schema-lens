// @ts-nocheck — 타입 주석 작업 중(155건 남음). 다 붙으면 이 줄을 지운다.
// 포커스 모드: 레퍼런스 탐색기의 3열(피참조|포커스|참조) 뷰를 범용 모델로 이식.
import * as Semantics from '../src/semantics.ts';
import { ERD } from './erd.ts';
import type { Model, Ref, Table } from '../src/model.ts';
import type { Analysis } from '../src/semantics.ts';
import type { AppState } from './types.ts';

/** app이 넘겨주는 콜백 — 이동과 뒤로가기, 툴팁 */
type Callbacks = {
  go(name: string): void;
  back?: () => void;
  tooltip: { show(html: string, x: number, y: number): void; move(x: number, y: number): void; hide(): void };
};
const asEl = (t: EventTarget | null): Element | null => (t instanceof Element ? t : null);

export const Focus = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  let model: Model | null = null;
  let sem: Analysis | null = null;
  let S: AppState | null = null;
  let cb: Callbacks | null = null;
  let childrenEdges: Record<string, Ref[]> = {}, parentsEdges: Record<string, Ref[]> = {};

  const need = <T,>(v: T | null, what: string): T => {
    if (v == null) throw new Error(`Focus.init 전에 ${what}을(를) 썼습니다`);
    return v;
  };
  const M = (): Model => need(model, 'model');
  const SEM = (): Analysis => need(sem, 'sem');
  const ST = (): AppState => need(S, 'S');

  const $ = (id: string): HTMLElement => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`요소를 찾을 수 없습니다: #${id}`);
    return el;
  };
  const esc = (s: unknown): string => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const byName = (): Map<string, Table> => new Map((model?.tables ?? []).map((t) => [t.name, t]));

  function neighbors(name: string) {
    const parents: Record<string, Ref[]> = {}, children: Record<string, Ref[]> = {};
    const self: Ref[] = [];
    for (const r of model?.refs ?? []) {
      if (S?.filter === 'real' && r.kind === 'logical') continue;
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
    const j = SEM().junctions[other];
    if (j === undefined) return '';
    if (j === null) return 'N:M multi';
    const oe = j[0] === focus ? j[1] : j[1] === focus ? j[0] : '';
    return oe ? `N:M ↔ ${oe}` : 'N:M';
  }

  // onDelete 액션 칩 — 원문 문자열 표기, 미지정은 무칩. 실패 조건(NOT NULL set null,
  // default 없는 set default) 감지 시에만 ⚠ 부가. 논리 ref는 저강조 + DB 미전파 캐빗.
  function odcChip(r) {
    const od = SEM().refMeta[r.id].onDelete;
    if (!od.specified) return '';
    const t = byName().get(r.child.table);
    const fkCols = t ? t.cols.filter((c) => r.child.cols.includes(c.name)) : [];
    let warn = '';
    if (od.action === 'set null' && fkCols.some((c) => c.notNull)) warn = 'NOT NULL — 삭제 실패';
    else if (od.action === 'set default' && fkCols.some((c) => c.dflt == null)) warn = '기본값 없음 — 실패 가능';
    const cls = od.action === 'cascade' ? 'odc-cascade' : /^set /.test(od.action) ? 'odc-setnull' : 'odc-restrict';
    const caveat = r.kind === 'logical' ? ' · DBML 메타데이터 — DB가 전파하지 않음, 앱 구현 필요' : '';
    const title = `on delete ${od.raw}${warn ? ' · ⚠ ' + warn : ''}${caveat}`;
    return `<span class="odc ${cls}${r.kind === 'logical' ? ' lg' : ''}" title="${esc(title)}">${esc(od.raw)}${warn ? ' ⚠' : ''}</span>`;
  }

  // 툴팁 문장에 부가하는 삭제 동작 한 절 (onUpdate는 여기에만 노출)
  function actClause(r) {
    const m = SEM().refMeta[r.id], od = m.onDelete, ou = m.onUpdate;
    const WORDS = {
      'cascade': '부모 삭제 시 함께 삭제', 'set null': '부모 삭제 시 NULL 전환',
      'set default': '부모 삭제 시 기본값 전환', 'restrict': '부모 삭제 차단',
      'no action': '기본 동작(행이 있으면 차단)', 'unknown': `on delete ${od.raw}`,
    };
    let s = od.specified ? ` · ${WORDS[od.action]}${r.kind === 'logical' ? ' (앱 레벨 — DB 미전파)' : ''}` : '';
    if (ou.specified) s += ` · on update ${ou.raw}`;
    return s;
  }

  function relLine(r) {
    const m = SEM().refMeta[r.id], ty = SEM().TYPES[m.type];
    const lab = m.label === ty.label ? '' : `<b class="rm">${esc(m.label)}</b>`;
    return `<span data-ref="${esc(r.id)}" data-col="${esc(r.child.cols[0])}" title="${esc(m.sentence + actClause(r))}">${lab}<span class="ty" style="--c:var(${ty.cssVar})">${ty.label}</span><span class="cardchip">${m.card}</span>${odcChip(r)}<em>${esc(r.child.cols[0])}</em></span>`;
  }

  let lastImpact = null; // 영향권 모드 중 현재 포커스의 deleteImpact 결과

  function toggleImpact() {
    ST().impact = !ST().impact;
    render(ST().focusTable);
  }

  // ── 2-hop 미리보기(.fx) — 카드 형제 인라인 확장, 수동 peek은 동시 1개 ──
  function onwardCount(other) {
    const nb = neighbors(other);
    const s = new Set([...Object.keys(nb.parents), ...Object.keys(nb.children)]);
    s.delete(ST().focusTable); s.delete(other);
    return s.size;
  }

  function buildPeek(name) {
    const panel = document.createElement('div');
    panel.className = 'fx';
    const nb = neighbors(name);
    const TYPE_ORDER = Object.keys(SEM().TYPES);
    const rows = [];
    // ▶ = name이 참조하는 대상, ◀ = name을 참조하는 대상. 현재 포커스로 되돌아가는 엣지는 제외.
    for (const p in nb.parents) if (p !== ST().focusTable)
      for (const r2 of nb.parents[p]) rows.push({ r: r2, dir: '▶', other: p, ti: Math.max(0, TYPE_ORDER.indexOf(SEM().refMeta[r2.id].type)) });
    for (const c in nb.children) if (c !== ST().focusTable)
      for (const r2 of nb.children[c]) rows.push({ r: r2, dir: '◀', other: c, ti: Math.max(0, TYPE_ORDER.indexOf(SEM().refMeta[r2.id].type)) });
    rows.sort((a, b) => a.ti - b.ti || a.other.localeCompare(b.other));
    const shown = rows.slice(0, 6);
    panel.innerHTML = shown.map(({ r: r2, dir, other }) => {
      const m = SEM().refMeta[r2.id], ty = SEM().TYPES[m.type];
      return `<button type="button" class="fxrow" data-goto="${esc(other)}" title="${esc(m.sentence + actClause(r2))}">` +
        `<i>${dir}</i><span class="ty" style="--c:var(${ty.cssVar})">${ty.label}</span><b>${esc(other)}</b>` +
        `<span class="cardchip">${m.card}</span>${odcChip(r2)}</button>`;
    }).join('') + (rows.length > 6 ? `<div class="fxmore">+ ${rows.length - 6} — 포커스로 이동해 보기</div>` : '');
    panel.querySelectorAll<HTMLElement>('.fxrow').forEach((b) =>
      b.addEventListener('click', () => cb?.go(b.dataset.goto)));
    return panel;
  }

  function closePeek() {
    const open = document.querySelector('#focuswrap .fitem > .fx');
    if (!open) return false;
    const card = open.parentElement.querySelector('.fnode');
    const b = card && card.querySelector('.fxbtn');
    if (b) b.setAttribute('aria-expanded', 'false');
    open.remove();
    return true;
  }

  function togglePeek(card, focusFirst) {
    if (ST().impact) return; // 영향권 모드의 .fx 슬롯은 체인이 소유(모드 파생·다중) — 수동 peek 비활성
    const wrap = card.parentElement;
    if (!wrap || !wrap.classList.contains('fitem')) return;
    const wasOpen = !!wrap.querySelector('.fx');
    closePeek(); // 항상 하나만 — 다른 카드에서 열면 이전 것 닫힘
    if (wasOpen) { drawWires(); return; }
    const panel = buildPeek(card.dataset.name);
    wrap.appendChild(panel);
    const b = card.querySelector('.fxbtn');
    if (b) b.setAttribute('aria-expanded', 'true');
    if (focusFirst) {
      const r = panel.querySelector('.fxrow');
      if (r) r.focus({ preventScroll: true });
    }
    drawWires(); // 확장으로 아래 카드들이 밀림 — 재정박
  }

  // CLI --peek: 대상이 이웃이 아니면 실패(fail-fast), fmore로 접혀 있으면 자동 펼침 후 열기
  function openPeek(name) {
    const card = document.querySelector(`#focuswrap .fnode[data-name="${CSS.escape(name)}"]`);
    if (!card) return false;
    if (card.classList.contains('fmore-hidden'))
      card.closest('.fcol').querySelectorAll<HTMLElement>('button.fmore').forEach((b) => b.click());
    togglePeek(card, false);
    return true;
  }

  // 카드 셸: non-button div(로빙 커서 타깃) + 내부 명시 컨트롤(실제 button).
  // 이동은 셸 레벨(클릭·Enter), 내부 버튼에서 버블된 클릭은 이동으로 취급하지 않는다.
  function nodeCard(other, edges) {
    const t = byName().get(other);
    const gv = ST().groupColor[t && t.group] || '--gc-x';
    const elB = document.createElement('div');
    elB.className = 'fnode'; elB.dataset.name = other;
    elB.tabIndex = -1;
    elB.setAttribute('role', 'option');
    elB.setAttribute('aria-label', other);
    elB.style.setProperty('--gc', `var(${gv})`);
    const jt = junctionTag(other, ST().focusTable);
    // 조인테이블이면 반대편으로 바로 건너뛰는 링크 — 경유지 2클릭을 1클릭으로
    const j = SEM().junctions[other];
    const far = Array.isArray(j) ? (j[0] === ST().focusTable ? j[1] : j[1] === ST().focusTable ? j[0] : '') : '';
    const onwardN = ST().impact ? 0 : onwardCount(other); // 영향권 모드에선 .fx 슬롯을 체인이 사용
    elB.innerHTML =
      `<span class="nname">${esc(other)}${jt ? `<span class="nm-tag">${esc(jt)}</span>` : ''}</span>` +
      `<span class="nmean">${esc((t && t.note) || '')}</span>` +
      `<span class="nrel">${edges.map(relLine).join('')}</span>` +
      (onwardN ? `<button type="button" class="fxbtn" aria-expanded="false">⌄ 다음 관계 ${onwardN}</button>` : '') +
      (far && far !== other ? `<button type="button" class="fskip">↔ ${esc(far)} 바로가기</button>` : '');
    elB.addEventListener('click', (e) => { if (e.target.closest('button')) return; cb?.go(other); });
    elB.addEventListener('pointerenter', () => setHot(other, null, true));
    elB.addEventListener('pointerleave', () => setHot(null, null, false));
    elB.addEventListener('focus', () => setHot(other, null, true));
    elB.addEventListener('blur', () => setHot(null, null, false));
    // 관계가 2개 이상이면 카드 안 via 행이 2차 정거장 — 행 단위 hot (우열만 와이어가 행 단위)
    const rows = elB.querySelectorAll<HTMLElement>('.nrel > span');
    if (rows.length >= 2) rows.forEach((sp) => {
      sp.tabIndex = -1;
      sp.addEventListener('focus', () => setHot(other, elB.closest('#fcolR') ? sp.dataset.col : null, true));
      sp.addEventListener('blur', () => setHot(null, null, false));
    });
    const skip = elB.querySelector('.fskip');
    if (skip) skip.addEventListener('click', () => cb?.go(far));
    const fxb = elB.querySelector('.fxbtn');
    if (fxb) fxb.addEventListener('click', () => togglePeek(elB, false));
    return elB;
  }

  function focusCard(t) {
    const gv = ST().groupColor[t.group] || '--gc-x';
    const div = document.createElement('div');
    div.className = 'ffocus'; div.style.setProperty('--gc', `var(${gv})`);
    const passesFilter = (r) => ST().filter !== 'real' || r.kind === 'real';
    const selfRef = M().refs.find((r) => r.self && r.child.table === t.name && passesFilter(r));
    // ERD와 같은 규칙으로 컬럼 필터 — 키만: PK/UNIQUE/FK 멤버
    const fkColsAll = new Set(M().refs.filter((r) => r.child.table === t.name && passesFilter(r)).flatMap((r) => r.child.cols));
    const colsShown = ST().colsMode === 'all' ? t.cols : t.cols.filter((c) => c.pk || c.unique || fkColsAll.has(c.name));
    const hiddenN = t.cols.length - colsShown.length;
    let rows = '';
    for (const c of colsShown) {
      const nullable = !c.pk && !c.notNull;
      let b = '';
      if (c.pk) b += '<span class="badge pk">PK</span>';
      if (c.unique) b += '<span class="badge uq">UQ</span>';
      // 이 컬럼이 선두인 ref를 우선, 없으면 복합 FK의 후행 멤버 여부 확인
      const ref = M().refs.find((r) => r.child.table === t.name && r.child.cols[0] === c.name && passesFilter(r));
      const memberRef = !ref && M().refs.find((r) => r.child.table === t.name && r.child.cols.includes(c.name) && passesFilter(r));
      let cell;
      if (ref) {
        const m = SEM().refMeta[ref.id], ty = SEM().TYPES[m.type];
        const tychip = `<span class="ty" style="--c:var(${ty.cssVar})">${ty.label}</span>`;
        if (ref.self) cell = `<span class="fkcell">${tychip}${odcChip(ref)}<span class="fk self">⟲ ${esc(m.label)}</span></span>`;
        else {
          const fkm = m.label === ty.label ? '' : `<span class="fkm">${esc(m.label)}</span>`;
          cell = `<span class="fkcell" title="${esc(m.sentence + actClause(ref))}">${fkm}${tychip}<span class="cardchip">${m.card}</span>${odcChip(ref)}` +
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
    if (hiddenN > 0) rows += `<div class="col-row cmore">… ${hiddenN}개 컬럼 더 (전체 컬럼으로 보기)</div>`;
    const nb = neighbors(t.name);
    const nc = Object.keys(nb.children).length, np = Object.keys(nb.parents).length;
    const j = SEM().junctions[t.name];
    const jb = j !== undefined ? `<span class="f-nm">${j === null ? 'N:M multi 링크' : `N:M 연결 · ${esc(j[0])} ↔ ${esc(j[1])}`}</span>` : '';
    // 영향권 요약 — 거부권 우선, 보장/앱 레벨 분리 (n = dedupe 테이블 수)
    let impactHtml = '';
    if (ST().impact && lastImpact) {
      const sm = lastImpact.summary, v = lastImpact.vetoed;
      const cnt = (fn) => v.filter(fn).length;
      const restrictN = cnt((x) => x.reason !== 'unspecified' && x.reason !== 'not-null');
      const unspecN = cnt((x) => x.reason === 'unspecified');
      const nnN = cnt((x) => x.reason === 'not-null');
      const parts = [];
      if (v.length) parts.push('<b class="iv">⚠ 삭제 차단</b> — ' +
        [restrictN ? `restrict ${restrictN}` : '', unspecN ? `미지정 ${unspecN}` : '', nnN ? `NOT NULL ${nnN}` : '']
          .filter(Boolean).join(' · ') + ' <em>(행이 존재하면 루트 삭제 실패)</em>');
      const g = sm.guaranteed;
      const flow = [g.cascade.length ? `연쇄 <b>${g.cascade.length}</b>테이블(최대 ${sm.maxDepth}단계)` : '',
        g.setNull.length ? `NULL <b>${g.setNull.length}</b>` : '',
        g.setDefault.length ? `기본값 <b>${g.setDefault.length}</b>` : ''].filter(Boolean).join(' · ');
      if (flow) parts.push(flow);
      const ap = [sm.app.cascade.length ? `연쇄 ${sm.app.cascade.length}` : '',
        sm.app.orphan.length ? `고아 가능 ${sm.app.orphan.length}` : ''].filter(Boolean).join(' · ');
      if (ap) parts.push(`앱 레벨(비보장): ${ap}`);
      impactHtml = `<div class="f-impact">${parts.join('<span class="sep">·</span>') || '삭제 영향 없음'}</div>`;
    }
    div.innerHTML =
      `<div class="f-head"><div class="f-top"><span class="f-name">${esc(t.name)}</span>` +
      `${selfRef ? '<span class="f-self">⟲ self-ref</span>' : ''}${jb}</div></div>` +
      impactHtml +
      `${t.note ? `<div class="f-note">${esc(t.note)}</div>` : ''}` +
      `<div class="f-cols">${rows}</div>` +
      `<div class="f-foot"><span>피참조 <b>${nc}</b></span><span>참조 <b>${np}</b></span><span>컬럼 <b>${t.cols.length}</b></span>` +
      `<button type="button" class="fimpact" aria-pressed="${!!ST().impact}">삭제 영향</button></div>`;
    div.querySelector('.fimpact').addEventListener('click', toggleImpact);
    div.tabIndex = -1; // 키보드 홈 위치
    div.querySelectorAll<HTMLElement>('.fk[data-goto]').forEach((a) =>
      a.addEventListener('click', (e) => { e.stopPropagation(); cb?.go(a.dataset.goto); }));
    // FK 행 hover/focus → 대응 와이어·이웃 카드 하이라이트 (키보드 커서 = hover)
    div.querySelectorAll<HTMLElement>('.col-row').forEach((row) => {
      const col = row.dataset.col;
      if (!M().refs.some((r) => r.child.table === t.name && r.child.cols[0] === col && !r.self)) return;
      row.tabIndex = -1;
      row.addEventListener('pointerenter', () => setHot(null, col, true));
      row.addEventListener('pointerleave', () => setHot(null, null, false));
      row.addEventListener('focus', () => setHot(null, col, true));
      row.addEventListener('blur', () => setHot(null, null, false));
    });
    return div;
  }

  // ── 키보드 라우터 — 로빙 DOM focus, 커서 = document.activeElement ──
  // 소유권 규칙: target이 실제 button이면 Enter/Space는 native 활성화 우선(라우터 불개입).
  // 라우터는 화살표/Backspace 항법만 소유한다.
  const isEditableTarget = (el) =>
    !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

  function stationsOf(colEl) {
    // 1차 정거장 = 카드 셸(+fmore 버튼), 관계 2개 이상 카드는 via 행, 열린 .fx는 그 행들이 뒤따름
    const out = [];
    for (const el of colEl.querySelectorAll<HTMLElement>('.fnode:not(.fmore-hidden), button.fmore')) {
      out.push(el);
      if (el.classList.contains('fnode')) {
        el.querySelectorAll<HTMLElement>('.nrel > span[tabindex]').forEach((r) => out.push(r));
        const fx = el.parentElement && el.parentElement.querySelector('.fx');
        if (fx) fx.querySelectorAll<HTMLElement>('.fxrow').forEach((r) => out.push(r));
      }
    }
    return out;
  }
  const focusEl = (el) => {
    if (!el) return false;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest' });
    return true;
  };

  function onKey(e) {
    if (isEditableTarget(e.target)) return false;
    const k = e.key;
    const a = document.activeElement;
    const inWrap = !!a && $('focuswrap').contains(a);
    if ((k === 'Enter' || k === ' ') && a && a.closest && a.closest('button')) return false;

    if (k === 'Backspace' || (k === 'ArrowLeft' && e.altKey)) {
      if (cb?.back) { e.preventDefault(); cb.back(); return true; }
      return false;
    }

    if (k === 'Escape') {
      if (e.shiftKey) return false; // Shift+Esc = 즉시 ERD (상위 계층으로 통과)
      // 겹 벗기기: 열린 .fx 닫기 → 영향권 모드 해제 → (상위) ERD 복귀
      if (closePeek()) { drawWires(); return true; }
      if (ST().impact) { toggleImpact(); return true; }
      return false;
    }

    if (k === 'd' || k === 'D') { toggleImpact(); return true; }

    if (k === ' ') {
      const card = inWrap && a.closest && a.closest('.fnode');
      if (card) { e.preventDefault(); togglePeek(card, true); return true; }
      return false;
    }

    if (k === 'ArrowUp' || k === 'ArrowDown') {
      e.preventDefault();
      const home = $('fcolM').querySelector('.ffocus');
      if (!inWrap) return focusEl(home); // 첫 진입은 중앙 홈
      const side = a.closest('#fcolL') || a.closest('#fcolR');
      let list;
      if (side) list = stationsOf(side);
      else {
        list = home ? [home, ...home.querySelectorAll<HTMLElement>('.col-row[tabindex]')] : [];
      }
      const idx = list.indexOf(a);
      if (idx === -1) return focusEl(list[0] || home);
      return focusEl(list[idx + (k === 'ArrowDown' ? 1 : -1)] || a) || true;
    }

    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      const home = $('fcolM').querySelector('.ffocus');
      if (!inWrap) return focusEl(home);
      const card = a.closest && a.closest('.fnode');
      const inL = !!a.closest('#fcolL'), inR = !!a.closest('#fcolR');
      if (!inL && !inR) { // 중앙 — 와이어 따라가기
        if (k === 'ArrowRight') {
          const col = a.dataset && a.dataset.col;
          if (col) for (const name in parentsEdges) {
            if (parentsEdges[name].some((r2) => r2.child.cols[0] === col)) {
              const tgt = document.querySelector(`#fcolR .fnode[data-name="${CSS.escape(name)}"]`);
              if (tgt) return focusEl(tgt);
            }
          }
          return focusEl($('fcolR').querySelector('.fnode')) || true;
        }
        return focusEl($('fcolL').querySelector('.fnode')) || true;
      }
      if (inL && k === 'ArrowRight') {
        // 좌열 → 중앙: drawWires가 쓰는 정박 행(rep.parent.cols[0])으로 역산
        const edges = (card && childrenEdges[card.dataset.name]) || [];
        const rep = edges.find((r2) => r2.kind === 'real') || edges[0];
        const row = rep && $('fcolM').querySelector(`.col-row[data-col="${CSS.escape(rep.parent.cols[0])}"]`);
        return focusEl(row || home);
      }
      if (inR && k === 'ArrowLeft') {
        const edges = (card && parentsEdges[card.dataset.name]) || [];
        const row = edges[0] && $('fcolM').querySelector(`.col-row[data-col="${CSS.escape(edges[0].child.cols[0])}"]`);
        return focusEl(row || home);
      }
      // 바깥 방향(좌열 ←, 우열 →) = .fx 확장 토글
      if (card && ((inL && k === 'ArrowLeft') || (inR && k === 'ArrowRight'))) {
        togglePeek(card, true);
        return true;
      }
      return true;
    }

    if (k === 'Enter') {
      if (!inWrap) return false;
      const card = a.closest && a.closest('.fnode');
      if (card) { cb?.go(card.dataset.name); return true; }
      if (a.classList.contains('col-row')) {
        const link = a.querySelector('.fk[data-goto]');
        if (link) cb?.go(link.dataset.goto);
        return true;
      }
      return a.classList.contains('ffocus'); // 홈에서 Enter는 무동작 소비
    }
    return false;
  }

  // ── 영향권(삭제 영향) 모드 — 좌열을 액션 섹션으로 재구성, 섹션이 ref/via 행을 소유 ──
  // 혼합 액션 child는 섹션마다 분할 등장(섹션당 1장). 체인은 depth≤2 자동, 이하 배지+수동.
  function chainRow(en, level) {
    const lbl = en.specified ? (en.raw || en.action) : '미지정';
    const cls = en.action === 'cascade' ? 'odc-cascade' : /^set /.test(en.action) ? 'odc-setnull' : 'odc-restrict';
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'fxrow chain';
    b.dataset.goto = en.table;
    b.style.setProperty('--lv', level - 2);
    b.innerHTML = `<i>└</i><b>${esc(en.table)}</b>` +
      `<span class="odc ${cls}${en.kind === 'logical' ? ' lg' : ''}">${esc(lbl)}</span>` +
      (en.warning ? '<em>⚠</em>' : '') + (en.cycle ? '<em>⟲ 재귀</em>' : '') + (en.dedup ? '<em>중복 경로</em>' : '');
    b.title = `${en.table} — ${Semantics.ACTIONS[en.action].label}${en.guaranteed ? '' : ' (앱 레벨 — DB 보장 없음)'}${en.warning ? ' · ' + en.warning : ''}`;
    b.addEventListener('click', () => cb?.go(b.dataset.goto));
    return b;
  }
  function countDesc(entries) {
    let n = 0;
    (function w(l) { for (const e of l) { n++; w(e.children || []); } })(entries);
    return n;
  }
  function appendChain(panel, entries, level) {
    for (const en of entries) {
      panel.appendChild(chainRow(en, level));
      if (!en.children || !en.children.length) continue;
      if (level < 2) appendChain(panel, en.children, level + 1);
      else {
        const badge = document.createElement('button');
        badge.type = 'button'; badge.className = 'fxmore chainmore';
        badge.style.setProperty('--lv', level - 1);
        badge.textContent = `…${countDesc(en.children)}단계 더 (펼치기)`;
        const kids = en.children;
        badge.addEventListener('click', () => {
          const box = document.createElement('div');
          box.className = 'chainwrap';
          appendChain(box, kids, level + 1);
          badge.replaceWith(box);
          drawWires();
        });
        panel.appendChild(badge);
      }
    }
  }

  function fillImpact(colEl, impact) {
    colEl.setAttribute('role', 'listbox');
    if (!impact.entries.length) {
      colEl.innerHTML = '<div class="empty">이 테이블을 참조하는 FK 없음 — 삭제 영향 없음</div>';
      return;
    }
    const refById = new Map(M().refs.map((r) => [r.id, r]));
    const CATS = [
      { label: '연쇄 삭제', cssVar: '--act-cascade', test: (en) => en.kind === 'real' && en.action === 'cascade' },
      { label: 'NULL 전환', cssVar: '--act-setnull', test: (en) => en.kind === 'real' && en.action === 'set null' && !en.veto },
      { label: '기본값 전환', cssVar: '--act-setnull', test: (en) => en.kind === 'real' && en.action === 'set default' },
      { label: '삭제 차단', cssVar: '--act-restrict', test: (en) => en.kind === 'real' && en.veto && en.specified },
      { label: '기본 동작(미지정 — 행이 있으면 차단)', cssVar: '--act-restrict', soft: true, test: (en) => en.kind === 'real' && en.veto && !en.specified },
      { label: '앱 레벨(비보장) — 필터와 무관하게 표시', cssVar: '--logical', soft: true, test: (en) => en.kind === 'logical' && !en.orphan && en.specified },
      { label: '고아 가능(논리·표기 없음)', cssVar: '--logical', soft: true, test: (en) => en.kind === 'logical' && en.orphan },
    ];
    for (const cat of CATS) {
      const ens = impact.entries.filter(cat.test);
      if (!ens.length) continue;
      const hd = document.createElement('div');
      hd.className = 'f-typehead' + (cat.soft ? ' soft' : '');
      hd.innerHTML = `<span class="ty" style="--c:var(${cat.cssVar})">${esc(cat.label)}</span><span class="cnt">${ens.length}</span>`;
      colEl.appendChild(hd);
      const byTable = new Map();
      for (const en of ens) {
        if (!byTable.has(en.table)) byTable.set(en.table, []);
        byTable.get(en.table).push(en);
      }
      for (const [tbl, list] of byTable) {
        const card = nodeCard(tbl, list.map((en) => refById.get(en.refId)).filter(Boolean));
        card.dataset.refids = list.map((en) => en.refId).join(','); // 와이어 정박을 섹션 소유 ref로 한정
        const wrap = document.createElement('div');
        wrap.className = 'fitem';
        wrap.appendChild(card);
        const kids = list.flatMap((en) => en.children || []);
        if (kids.length) {
          const panel = document.createElement('div');
          panel.className = 'fx fxchain';
          appendChain(panel, kids, 2);
          wrap.appendChild(panel);
        }
        colEl.appendChild(wrap);
      }
    }
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
    wires.querySelectorAll<HTMLElement>('g.fw').forEach((g) => {
      g.classList.toggle('hot', on && (!other || g.dataset.other === other) && (!col || g.dataset.col === col));
    });
    document.querySelectorAll<HTMLElement>('#focuswrap .fnode.hot').forEach((n) => n.classList.remove('hot'));
    if (on && other) {
      const n = document.querySelector(`#focuswrap .fnode[data-name="${CSS.escape(other)}"]`);
      if (n) n.classList.add('hot');
    }
    const fe = $('fcolM').querySelector('.ffocus');
    if (fe) {
      fe.querySelectorAll<HTMLElement>('.col-row.hot').forEach((r2) => r2.classList.remove('hot'));
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
    // 관계(엣지) 하나 = 와이어 하나. 기본은 중립색, hover/hot 시 유형색으로 강조(dbdiagram 문법).
    const mk = (a, b2, ay, by, ref, info, cls) => {
      const m = SEM().refMeta[ref.id], cvar = SEM().TYPES[m.type].cssVar;
      const g = mkNS('g', { class: 'fw' + (cls ? ' ' + cls : '') });
      g.style.setProperty('--c', `var(${cvar})`);
      g.dataset.other = info.other; g.dataset.col = info.col || '';
      const dx = Math.max(50, Math.abs(b2 - a) * 0.5);
      const d = `M${a},${ay} C${a + dx},${ay} ${b2 - dx},${by} ${b2},${by}`;
      const p = mkNS('path', { d, class: 'w', 'stroke-width': '2', 'stroke-linecap': 'round' });
      if (ref.kind === 'logical') p.setAttribute('stroke-dasharray', '6 4');
      g.appendChild(p);
      const arr = mkNS('path', { d: `M${b2},${by} l-8,-3.6 v7.2 Z`, class: 'wa' });
      g.appendChild(arr);
      const dot = mkNS('circle', { cx: a, cy: ay, r: '3.2', class: 'wd' });
      g.appendChild(dot);
      const hit = mkNS('path', { d, class: 'hit' });
      hit.addEventListener('pointerenter', (e) => {
        setHot(info.other, info.col, true);
        if (cb?.tooltip) cb?.tooltip.show(`<b>${esc(m.label)}</b> — ${esc(m.sentence + actClause(ref))}`, e.clientX, e.clientY);
      });
      hit.addEventListener('pointermove', (e) => { if (cb?.tooltip) cb?.tooltip.move(e.clientX, e.clientY); });
      hit.addEventListener('pointerleave', () => { setHot(null, null, false); if (cb?.tooltip) cb?.tooltip.hide(); });
      g.appendChild(hit);
      wires.appendChild(g);
    };
    // 좌열(피참조): 카드당 1선 — 포커스 카드의 피참조 컬럼 행(대개 id)으로 팬인
    $('fcolL').querySelectorAll<HTMLElement>('.fnode').forEach((nd) => {
      if (!nd.offsetParent) return; // 접힌 카드 스킵
      const name = nd.dataset.name;
      let edges = childrenEdges[name] || [];
      // 영향권 모드: 같은 테이블이 섹션마다 분할 등장 — 정박은 카드가 소유한 ref로 한정
      if (nd.dataset.refids) {
        const ids = new Set(nd.dataset.refids.split(','));
        edges = edges.filter((e2) => ids.has(e2.id));
      }
      if (!edges.length) return;
      const b = pt(nd, st);
      const rep = edges.find((e) => e.kind === 'real') || edges[0];
      const ay = rowY(rep.parent.cols[0]);
      mk(b.r, F.l, b.cy, ay != null ? ay : clamp(b.cy, F.t + 12, F.b - 12), rep, { other: name, col: '' });
    });
    // 우열(참조): 엣지당 1선 — 포커스 카드의 실제 FK 컬럼 행에서 출발, 같은 카드 도착은 스프레드
    $('fcolR').querySelectorAll<HTMLElement>('.fnode').forEach((nd) => {
      if (!nd.offsetParent) return;
      const name = nd.dataset.name, edges = parentsEdges[name] || [];
      const b = pt(nd, st);
      edges.forEach((edge, i) => {
        const sy = rowY(edge.child.cols[0]);
        const by = b.cy + (i - (edges.length - 1) / 2) * 12;
        mk(F.r, b.l, sy != null ? sy : clamp(b.cy, F.t + 12, F.b - 12), by, edge, { other: name, col: edge.child.cols[0] }, 'rw');
      });
    });
  }

  async function render(name: string): Promise<void> {
    const t = byName().get(name);
    const L = $('fcolL'), M = $('fcolM'), R = $('fcolR');
    // 재렌더 전 커서 서술자 보존(인스턴스 키 우선) — 재구축 후 복원, 소멸 시 중앙 폴백
    const prevA = document.activeElement;
    let cursor = null;
    if (prevA && $('focuswrap').contains(prevA)) {
      if (prevA.classList.contains('ffocus')) cursor = { kind: 'home' };
      else if (prevA.dataset && prevA.dataset.ref) cursor = { kind: 'row', ref: prevA.dataset.ref };
      else if (prevA.classList.contains('col-row')) cursor = { kind: 'colrow', col: prevA.dataset.col };
      else {
        const c = prevA.closest && prevA.closest('.fnode');
        if (c) cursor = { kind: 'card', name: c.dataset.name };
      }
    }
    L.setAttribute('role', 'listbox'); R.setAttribute('role', 'listbox');
    L.innerHTML = ''; M.innerHTML = ''; R.innerHTML = '';
    if (!t) {
      // 미존재 테이블 — 낡은 뷰를 남기지 않고 정리
      $('fwires').innerHTML = '';
      $('cnt-l').textContent = 0; $('cnt-r').textContent = 0;
      M.innerHTML = `<div class="empty">「${esc(name || '')}」 — 존재하지 않는 테이블</div>`;
      return Promise.resolve();
    }
    ST().focusTable = name;
    const nb = neighbors(name);
    childrenEdges = nb.children; parentsEdges = nb.parents;
    lastImpact = ST().impact ? Semantics.deleteImpact(model, name) : null;
    $('focuswrap').classList.toggle('impact', !!ST().impact);
    const ck = Object.keys(nb.children).sort(), pk = Object.keys(nb.parents).sort();
    // 좌열: 관계 유형 순 섹션 + 색 헤더, 섹션당 6개 초과분은 접기
    const TYPE_ORDER = Object.keys(SEM().TYPES);
    const fillLeft = (colEl, map) => {
      const list = Object.keys(map).map((o) => ({
        other: o, edges: map[o],
        ti: Math.max(0, TYPE_ORDER.indexOf(SEM().refMeta[map[o][0].id].type)),
      })).sort((a, b) => a.ti - b.ti || b.edges.length - a.edges.length || a.other.localeCompare(b.other));
      if (!list.length) { colEl.innerHTML = '<div class="empty">— 없음 —</div>'; return; }
      const sections = [];
      for (const it of list) {
        if (!sections.length || sections[sections.length - 1].ti !== it.ti) sections.push({ ti: it.ti, items: [] });
        sections[sections.length - 1].items.push(it);
      }
      for (const sec of sections) {
        const ty = SEM().TYPES[TYPE_ORDER[sec.ti]];
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
          const wrap = document.createElement('div');
          wrap.className = 'fitem';
          wrap.appendChild(card);
          colEl.appendChild(wrap);
        });
        if (fold) {
          const btn = document.createElement('button');
          btn.className = 'fmore';
          btn.textContent = `+ ${sec.items.length - 5}개 더 보기`;
          btn.addEventListener('click', () => {
            hiddenCards.forEach((c) => c.classList.remove('fmore-hidden'));
            btn.remove(); // activeElement 소실 — 첫 공개 카드로 포커스 이관
            if (hiddenCards[0]) hiddenCards[0].focus({ preventScroll: true });
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
      for (const it of list) {
        const wrap = document.createElement('div');
        wrap.className = 'fitem';
        wrap.appendChild(nodeCard(it.other, it.edges));
        colEl.appendChild(wrap);
      }
    };
    if (ST().impact) fillImpact(L, lastImpact);
    else fillLeft(L, nb.children);
    M.appendChild(focusCard(t));
    fillRight(R, nb.parents);
    $('cnt-l').textContent = ck.length; $('cnt-r').textContent = pk.length;
    // 와이어 정박·커서 복원까지 끝난 뒤 resolve — 스크린샷 캡처가 암묵적 rAF 순서에 의존하지 않게
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
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
      // 커서 복원 — 인스턴스 키(data-ref) → 이름/컬럼 → 중앙 홈 폴백
      if (cursor) {
        let el = null;
        if (cursor.kind === 'home') el = f;
        else if (cursor.kind === 'row')
          el = document.querySelector(`#focuswrap .nrel > span[data-ref="${CSS.escape(cursor.ref)}"]`);
        else if (cursor.kind === 'colrow')
          el = M.querySelector(`.col-row[data-col="${CSS.escape(cursor.col)}"]`);
        else if (cursor.kind === 'card')
          el = document.querySelector(`#focuswrap .fnode[data-name="${CSS.escape(cursor.name)}"]`);
        const target = el || f;
        if (target) target.focus({ preventScroll: true });
      }
      resolve();
    })));
  }

  return {
    init(m: Model, s: Analysis, state: AppState, callbacks: Callbacks): void { model = m; sem = s; S = state; cb = callbacks; },
    render, drawWires, onKey, isEditableTarget, openPeek,
  };
})();
