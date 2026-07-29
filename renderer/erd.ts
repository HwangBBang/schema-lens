// 전체 ERD 캔버스: elk 자동배치 + SVG 렌더 + 줌/팬 + 노드 드래그 + 관계 하이라이트.
// 허브(users 등) 유입 엣지는 기본 접힘 → 카드 하단 칩으로 축약, 선택/토글 시에만 표시.
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { Column, Model, Ref, Table } from '../src/model.ts';
import { columnFacts } from '../src/column-facts.ts';
import type { ColumnFk } from '../src/column-facts.ts';
import type { Analysis, RefMeta } from '../src/semantics.ts';
import type { AppState } from './types.ts';

/** app이 넘겨주는 콜백 — 선택(해제는 null), 포커스 진입, 툴팁 */
type Callbacks = {
  onSelect(name: string | null): void;
  onOpenFocus(name: string): void;
  tooltip: { show(html: string, x: number, y: number): void; move(x: number, y: number): void; hide(): void };
};

/** 카드 하나의 배치 상자. rowY는 표시된 컬럼 행의 중심 y(카드 좌상단 기준) */
type NodeBox = { x: number; y: number; w: number; h: number; rowY: Record<string, number> };
/** localStorage에 저장하는 파일별 카드 좌표 — 외부에서 온 값이라 항목이 비어 있을 수 있다 */
type SavedPositions = Record<string, { x: number; y: number } | undefined>;
type Transform = { x: number; y: number; k: number };
type EdgeEl = { el: SVGGElement; ref: Ref; meta: RefMeta };
type HullEls = { rect: SVGRectElement; lab: SVGTextElement };
/** 라우팅 좌표. 튜플이라 인덱싱에 undefined가 붙지 않는다 */
type Pt = [number, number];

export const ERD = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 232, HDR = 28, ROW = 18, CHIP = 20, PADB = 8;

  let svg: SVGSVGElement | null = null;
  let vp: SVGGElement | null = null;
  let cb: Callbacks | null = null;
  let model: Model | null = null;
  let sem: Analysis | null = null;
  let S: AppState | null = null;
  let pos: Record<string, NodeBox> = {};        // table → 배치 상자
  let edgeEls: EdgeEl[] = [];
  let nodeEls: Record<string, SVGGElement> = {};
  let hullByGroup: Record<string, HullEls> = {}; // group → 헐 — 노드 드래그 시 실시간 리사이즈용
  let tf: Transform = { x: 40, y: 40, k: 1 };
  let customLayout = false;
  let pendingFit = false;

  const need = <T,>(v: T | null | undefined, what: string): T => {
    if (v == null) throw new Error(`ERD.mount/load 전에 ${what}을(를) 썼습니다`);
    return v;
  };
  const MODEL = (): Model => need(model, 'model');
  const SEM = (): Analysis => need(sem, 'sem');
  const ST = (): AppState => need(S, 'S');
  const SVG = (): SVGSVGElement => need(svg, 'svg');
  const VP = (): SVGGElement => need(vp, 'vp');
  const CB = (): Callbacks => need(cb, 'cb');
  /** 관계 메타는 analyze가 모든 ref에 대해 채운다 — 없으면 모델과 분석이 어긋난 것이다 */
  const metaOf = (r: Ref): RefMeta => need(SEM().refMeta[r.id], `refMeta[${r.id}]`);

  const el = <K extends keyof SVGElementTagNameMap>(
    tag: K,
    attrs?: Record<string, string | number> | null,
    parent?: Element | null,
  ): SVGElementTagNameMap[K] => {
    const e = document.createElementNS(NS, tag);
    const a: Record<string, string | number | undefined> = attrs || {};
    for (const k in a) e.setAttribute(k, String(a[k]));
    if (parent) parent.appendChild(e);
    return e;
  };
  const trunc = (s: string | null | undefined, n: number): string => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
  const esc = (s: unknown): string => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ── 표시 행 계산 ─────────────────────────────────────────
  function rowsFor(t: Table) {
    const fkCols = new Set(MODEL().refs.filter((r) => r.child.table === t.name).map((r) => r.child.cols[0] ?? ''));
    let shown = ST().colsMode === 'all' ? t.cols : t.cols.filter((c) => c.pk || c.unique || fkCols.has(c.name));
    if (!shown.length) shown = t.cols.slice(0, 1);
    return { shown, hidden: t.cols.length - shown.length, fkCols };
  }
  function hubLinksFor(tname: string): { hub: string; refs: Ref[] }[] {
    const links: { hub: string; refs: Ref[] }[] = [];
    for (const h of SEM().hubs) {
      const rs = MODEL().refs.filter((r) => r.child.table === tname && r.parent.table === h.table && !r.self);
      if (rs.length) links.push({ hub: h.table, refs: rs });
    }
    return links;
  }
  function nodeSize(t: Table): { w: number; h: number } {
    const { shown, hidden } = rowsFor(t);
    const chips = hubLinksFor(t.name).length;
    const rows = shown.length + (hidden > 0 ? 1 : 0);
    return { w: W, h: HDR + 4 + rows * ROW + chips * CHIP + PADB };
  }

  // ── 레이아웃 ─────────────────────────────────────────────
  function posStoreKey(): string { return `dbv-pos:${ST().filePath || 'untitled'}`; }
  function savePositions(): void {
    try {
      const out: Record<string, { x: number; y: number }> = {};
      for (const k in pos) { const p = pos[k]!; out[k] = { x: Math.round(p.x), y: Math.round(p.y) }; }
      localStorage.setItem(posStoreKey(), JSON.stringify(out));
    } catch {}
  }
  function loadPositions(): SavedPositions | null {
    // 저장값이 없으면 null — computeLayout의 all-or-nothing 게이트가 이 null에 의존한다
    try {
      const raw = localStorage.getItem(posStoreKey());
      if (raw == null) return null;
      return JSON.parse(raw) as SavedPositions | null;
    } catch { return null; }
  }
  function clearPositions(): void { localStorage.removeItem(posStoreKey()); customLayout = false; }

  // 정렬 방식: group(그룹 묶음) | lr(가로 흐름) | tb(세로 흐름) | grid(격자) — 파일별 유지
  const MODES = ['group', 'lr', 'tb', 'grid'] as const;
  type LayoutMode = (typeof MODES)[number];
  /** localStorage·CLI·dataset에서 오는 값이라 런타임 검증이 필요하다 — 타입만으로 대체하지 말 것 */
  const isMode = (v: unknown): v is LayoutMode => typeof v === 'string' && (MODES as readonly string[]).includes(v);
  let layoutMode: LayoutMode = 'group';
  function layStoreKey(): string { return `dbv-lay:${ST().filePath || 'untitled'}`; }
  function loadLayoutMode(): void {
    const m = localStorage.getItem(layStoreKey());
    layoutMode = isMode(m) ? m : 'group';
  }

  // 격자: 그룹 순서 → 정의 순서로 균등 나열 (카드 폭이 동일해 열이 맞음)
  function gridLayout(): void {
    const m = MODEL();
    const order: Table[] = [];
    const grouped = new Set<string>();
    for (const g of m.groups) {
      for (const t of m.tables) if (t.group === g.name) { order.push(t); grouped.add(t.name); }
    }
    for (const t of m.tables) if (!grouped.has(t.name)) order.push(t);
    const cols = Math.max(1, Math.round(Math.sqrt(order.length * 1.7)));
    const GX = 60, GY = 48;
    pos = {};
    let x = 0, y = 0, rowH = 0, c = 0;
    for (const t of order) {
      const s = nodeSize(t);
      pos[t.name] = { x, y, w: s.w, h: s.h, rowY: {} };
      rowH = Math.max(rowH, s.h);
      if (++c >= cols) { c = 0; x = 0; y += rowH + GY; rowH = 0; }
      else x += s.w + GX;
    }
  }

  async function computeLayout(): Promise<void> {
    const m = MODEL();
    const saved = loadPositions();
    // 전부 아니면 전무 — 한 테이블이라도 저장값이 없으면 저장본을 통째로 버리고 elk로 간다
    const picked = saved ? m.tables.map((t) => saved[t.name]) : null;
    if (picked && picked.every((p) => !!p)) {
      pos = {};
      m.tables.forEach((t, i) => {
        const s = nodeSize(t);
        const sp = picked[i]!;
        pos[t.name] = { x: sp.x, y: sp.y, w: s.w, h: s.h, rowY: {} };
      });
      customLayout = true;
      return;
    }
    if (layoutMode === 'grid') { gridLayout(); customLayout = false; return; }
    const hubSet = new Set(SEM().hubs.map((h) => h.table));
    const nodeOf = (t: Table): ElkNode => { const s = nodeSize(t); return { id: t.name, width: s.w, height: s.h }; };
    const children: ElkNode[] = [];
    if (layoutMode === 'group') {
      const groups = m.groups.filter((g) => g.tables.some((tn) => m.tables.some((t) => t.name === tn)));
      const grouped = new Set<string>();
      for (const g of groups) {
        const members = m.tables.filter((t) => t.group === g.name);
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
      for (const t of m.tables) if (!grouped.has(t.name)) children.push(nodeOf(t));
    } else {
      // lr/tb: 그룹 묶음 없이 참조 구조만으로 흐름 배치
      for (const t of m.tables) children.push(nodeOf(t));
    }
    // 레이아웃용 엣지: 구조 엣지만(허브 유입/셀프 제외) — 접힌 엣지가 배치를 흔들지 않게
    const edges = m.refs
      .filter((r) => !r.self && !hubSet.has(r.parent.table))
      .map((r, i) => ({ id: 'e' + i, sources: [r.child.table], targets: [r.parent.table] }));

    const elk = new ELK();
    const res = await elk.layout({
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': layoutMode === 'tb' ? 'DOWN' : 'RIGHT',
        'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
        'elk.layered.spacing.nodeNodeBetweenLayers': '104',
        'elk.spacing.nodeNode': '56',
        'elk.spacing.componentComponent': '88',
        'elk.layered.mergeEdges': 'true',
      },
      children, edges,
    });
    pos = {};
    (function walk(node: ElkNode, ox: number, oy: number): void {
      for (const c of node.children || []) {
        if (c.id.startsWith('g:')) walk(c, ox + c.x!, oy + c.y!);
        else {
          // await 이후라 스냅샷 m이 아니라 전역을 다시 읽는다 — 배치가 도는 사이 다른 파일이
          // 열렸다면 사라진 테이블에서 멈추는 것이 원래 동작이다
          const t = MODEL().tables.find((x) => x.name === c.id);
          if (!t) throw new Error(`elk가 모르는 노드: ${c.id}`);
          const s = nodeSize(t);
          pos[c.id] = { x: ox + c.x!, y: oy + c.y!, w: s.w, h: s.h, rowY: {} };
        }
      }
    })(res, 0, 0);
    customLayout = false;
  }

  // ── 렌더 ────────────────────────────────────────────────
  function applyTf(): void {
    VP().setAttribute('transform', `translate(${tf.x},${tf.y}) scale(${tf.k})`);
    // 그룹 라벨은 줌아웃 시 화면 크기를 유지하도록 역보정 — 어느 배율에서도 그룹명이 읽히게
    const fs = Math.max(11, Math.min(11 / tf.k, 30));
    for (const gname in hullByGroup) hullByGroup[gname]!.lab.style.fontSize = fs + 'px';
    updateMinimapView();
  }

  function render(): void {
    tipCancel(); // 재렌더 시 툴팁·예약 고착 방지
    grid = null; // 배치가 바뀌었을 수 있으므로 라우팅 격자 무효화
    const m = MODEL();
    SVG().innerHTML = '';
    vp = el('g', { id: 'vp' }, SVG());
    const hullLayer = el('g', {}, vp);
    const edgeLayer = el('g', {}, vp);
    const nodeLayer = el('g', {}, vp);
    edgeEls = []; nodeEls = {}; hullByGroup = {};

    // 그룹 헐 — 그룹 정렬에서만. 흐름/격자 정렬에선 멤버가 흩어져 헐이 오해를 만든다
    if (layoutMode === 'group') {
      for (const g of m.groups) {
        const members = m.tables.filter((t) => t.group === g.name && pos[t.name]);
        if (!members.length) continue;
        const b = hullBox(members);
        const gv = ST().groupColor[g.name] || '--gc-x';
        const hg = el('g', { class: 'hullg', style: `--gc:var(${gv})` }, hullLayer);
        hg.dataset['group'] = g.name;
        const rect = el('rect', { class: 'hull', x: b.x, y: b.y, width: b.w, height: b.h, rx: 14 }, hg);
        const lab = el('text', { class: 'hull-label', x: b.x + 13, y: b.y + 19 }, hg);
        lab.textContent = `${g.name}  · ${members.length}`;
        hullByGroup[g.name] = { rect, lab };
      }
    }

    // 노드
    for (const t of m.tables) {
      if (!pos[t.name]) continue;
      nodeLayer.appendChild(nodeEl(t));
    }
    // 엣지 (노드 위 배치 순서상 엣지가 아래)
    const hubSet = new Set(SEM().hubs.map((h) => h.table));
    for (const r of m.refs) {
      const meta = metaOf(r);
      const g = el('g', {
        class: `edge ${meta.type}${r.kind === 'logical' ? ' logical' : ''}${!r.self && hubSet.has(r.parent.table) ? ' hub' : ''}`,
        style: `--c:var(${SEM().TYPES[meta.type].cssVar})`,
      }, edgeLayer);
      g.dataset['hub'] = !r.self && hubSet.has(r.parent.table) ? r.parent.table : '';
      g.dataset['child'] = r.child.table; g.dataset['parent'] = r.parent.table;
      drawEdge(g, r, meta);
      hookEdge(g, r, meta);
      edgeEls.push({ el: g, ref: r, meta });
    }
    applyHubToggles();
    buildMinimap();
    applyTf();
  }

  function nodeEl(t: Table): SVGGElement {
    const p = need(pos[t.name], `pos[${t.name}]`);
    const { shown, hidden, fkCols } = rowsFor(t);
    const links = hubLinksFor(t.name);
    const gv = ST().groupColor[t.group ?? ''] || '--gc-x';
    const tm = SEM().tableMeta[t.name];
    const g = el('g', { class: 'node', transform: `translate(${p.x},${p.y})`, style: `--gc:var(${gv})` });
    g.dataset['name'] = t.name;
    el('rect', { class: 'box', width: p.w, height: p.h, rx: 10 }, g);
    el('path', { class: 'hd', d: `M0 10 a10 10 0 0 1 10 -10 H${p.w - 10} a10 10 0 0 1 10 10 V${HDR} H0 Z` }, g);
    const title = el('text', { class: 'title', x: 11, y: 17 }, g);
    title.textContent = trunc(t.name, 26);
    let bx = 11 + Math.min(t.name.length, 26) * 6.9 + 6;
    if (tm?.junction) {
      el('rect', { class: 'badge-jn-bg', x: bx, y: 6, width: 27, height: 13, rx: 4 }, g);
      const bt = el('text', { class: 'badge-jn', x: bx + 4, y: 16 }, g); bt.textContent = 'N:M';
      bx += 31;
    }
    if (tm?.selfRef) { const s = el('text', { class: 'selfglyph', x: p.w - 16, y: 16 }, g); s.textContent = '⟲'; }

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
      const ref = fkCols.has(c.name) && MODEL().refs.find((r) => r.child.table === t.name && r.child.cols[0] === c.name);
      if (ref) {
        const meta = metaOf(ref);
        const ft = el('text', {
          class: `fkTo${ref.kind === 'logical' ? ' logical' : ''}`, x: p.w - 9, y: cy + 3.5,
          'text-anchor': 'end', style: `fill:var(${SEM().TYPES[meta.type].cssVar})`,
        }, g);
        ft.textContent = trunc((ref.self ? '⟲ ' : '→ ') + ref.parent.table, 15);
      } else {
        const ct = el('text', { class: 'ct', x: p.w - 9, y: cy + 3.5, 'text-anchor': 'end' }, g);
        ct.textContent = trunc(c.type, 13);
      }
      // 행 전체를 덮는 투명 히트 — 드래그·더블클릭은 .node 위임이라 영향받지 않는다
      const rowHit = el('rect', {
        x: 0, y, width: p.w, height: ROW, fill: 'transparent', style: 'pointer-events:all',
      }, g);
      rowHit.dataset['tipCol'] = c.name; // showTip이 이 행을 다시 찾는 열쇠
      rowHit.addEventListener('pointerenter', (ev: PointerEvent) => tipArm(colTooltipHtml(t, c), ev.clientX, ev.clientY));
      rowHit.addEventListener('pointerleave', () => tipCancel());
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
      const labels = [...new Set(L.refs.map((r) => metaOf(r).label))].join('·');
      const tx = el('text', { class: 'hubchip', x: 15, y: cy + 11.5 }, g);
      tx.textContent = trunc(`◦ ${L.hub} — ${labels}`, 32);
      const hit = el('rect', { x: 8, y: cy, width: p.w - 16, height: 16, fill: 'transparent', style: 'pointer-events:all;cursor:default' }, g);
      hit.dataset['tipHub'] = L.hub; // showTip이 이 칩을 다시 찾는 열쇠
      hit.addEventListener('pointerenter', (ev: PointerEvent) => {
        setHubHot(t.name, L.hub, true);
        tipArm(hubTooltipHtml(t.name, L.hub, L.refs), ev.clientX, ev.clientY);
      });
      hit.addEventListener('pointerleave', () => { setHubHot(t.name, L.hub, false); tipCancel(); });
      y += CHIP;
    }
    nodeEls[t.name] = g;
    return g;
  }

  function hullBox(members: Table[]): { x: number; y: number; w: number; h: number } {
    // 호출부(render·updateHull)가 pos에 있는 멤버만 넘긴다
    const boxes = members.map((t) => pos[t.name]!);
    const x2 = Math.max(...boxes.map((b) => b.x + b.w));
    const y2 = Math.max(...boxes.map((b) => b.y + b.h));
    const x = Math.min(...boxes.map((b) => b.x)) - 16, y = Math.min(...boxes.map((b) => b.y)) - 38;
    return { x, y, w: x2 + 16 - x, h: y2 + 14 - y };
  }
  // 멤버 하나가 움직여도 헐이 항상 그룹 전체를 감싸도록 재계산
  function updateHull(gname: string): void {
    const h = hullByGroup[gname];
    if (!h) return;
    const members = MODEL().tables.filter((t) => t.group === gname && pos[t.name]);
    if (!members.length) return;
    const b = hullBox(members);
    h.rect.setAttribute('x', String(b.x)); h.rect.setAttribute('y', String(b.y));
    h.rect.setAttribute('width', String(b.w)); h.rect.setAttribute('height', String(b.h));
    h.lab.setAttribute('x', String(b.x + 13)); h.lab.setAttribute('y', String(b.y + 19));
  }

  function setHubHot(child: string, hub: string, on: boolean): void {
    for (const e of edgeEls) {
      if (e.ref.child.table === child && e.ref.parent.table === hub)
        e.el.classList.toggle('hot', on);
    }
  }

  // ── 엣지 지오메트리 ──────────────────────────────────────
  // 폴백/미리보기용 직각 엘보(수평→수직→수평, 라운드 코너)
  function elbowWp(cx: number, cy: number, px: number, py: number): Pt[] {
    const mx = (cx + px) / 2;
    return [[cx, cy], [mx, cy], [mx, py], [px, py]];
  }
  // ── 격자 A* 라우팅 ──
  // 기본 곡선이 카드에 막히면, 카드 사이 통로를 지나는 직각(라운드 코너) 경로를 찾는다.
  // 선이 엔티티를 통과하지 않는 것이 전체 ERD 가독성의 전제.
  const CELL = 24, GRID_MARGIN = 28, INFLATE = 10;
  type Grid = {
    x: number; y: number; cols: number; rows: number;
    blocked: Uint8Array; dist: Float64Array; stamp: Int32Array; prev: Int32Array; gen: number;
  };
  let grid: Grid | null = null;    // 노드 위치 확정 변경 시 null로 무효화
  let fastPreview = false;         // 드래그 중에는 빠른 기본 곡선만 (확정 시 전체 재라우팅)

  function ensureGrid(): Grid | null {
    if (grid) return grid;
    let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
    for (const k in pos) {
      const b = pos[k]!;
      x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
      x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
    }
    if (x2 < x1) return null;
    const x = x1 - GRID_MARGIN, y = y1 - GRID_MARGIN;
    const cols = Math.ceil((x2 - x1 + GRID_MARGIN * 2) / CELL);
    const rows = Math.ceil((y2 - y1 + GRID_MARGIN * 2) / CELL);
    const blocked = new Uint8Array(cols * rows);
    for (const k in pos) {
      const b = pos[k]!;
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
  function freeCellFrom(g: Grid, wx: number, wy: number, dir: number): Pt | null {
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

  function gridRoute(cx: number, cy: number, px: number, py: number, parentRight: boolean): Pt[] | null {
    const g = ensureGrid();
    if (!g) return null;
    const start = freeCellFrom(g, cx, cy, parentRight ? 0 : 1);
    const goal = freeCellFrom(g, px, py, parentRight ? 1 : 0);
    if (!start || !goal) return null;
    const DIRS: readonly Pt[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const W = g.cols, H = g.rows;
    const gen = ++g.gen;
    const seen = (k: number): boolean => g.stamp[k] === gen;
    const sKey = (start[1] * W + start[0]) * 4 + (parentRight ? 0 : 1);
    g.stamp[sKey] = gen; g.dist[sKey] = 0; g.prev[sKey] = -1;
    const heap: Pt[] = [[Math.abs(start[0] - goal[0]) + Math.abs(start[1] - goal[1]), sKey]];
    const push = (it: Pt): void => {
      heap.push(it);
      for (let i = heap.length - 1; i > 0;) {
        const p = (i - 1) >> 1;
        if (heap[p]![0] <= heap[i]![0]) break;
        const t = heap[p]!; heap[p] = heap[i]!; heap[i] = t; i = p;
      }
    };
    const pop = (): Pt => {
      const top = heap[0]!, last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        for (let i = 0; ;) {
          const l = i * 2 + 1, r = l + 1; let m = i;
          if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
          if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
          if (m === i) break;
          const t = heap[m]!; heap[m] = heap[i]!; heap[i] = t; i = m;
        }
      }
      return top;
    };
    let found = -1, guard = 0;
    while (heap.length && guard++ < 200000) {
      const [, key] = pop();
      const dir = key & 3, cell = key >> 2, ci = cell % W, cj = (cell / W) | 0;
      if (ci === goal[0] && cj === goal[1]) { found = key; break; }
      const d0 = g.dist[key]!;
      for (let nd = 0; nd < 4; nd++) {
        const dd = DIRS[nd]!;
        const ni = ci + dd[0], nj = cj + dd[1];
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        if (g.blocked[nj * W + ni]) continue;
        const nk = (nj * W + ni) * 4 + nd;
        const cost = d0 + 1 + (nd === dir ? 0 : 1.6); // 턴 페널티 — 꺾임 최소화
        if (!seen(nk) || cost < g.dist[nk]!) {
          g.stamp[nk] = gen; g.dist[nk] = cost; g.prev[nk] = key;
          push([cost + Math.abs(ni - goal[0]) + Math.abs(nj - goal[1]), nk]);
        }
      }
    }
    if (found < 0) return null;
    // 셀 경로 복원 → 방향 전환점만 추출 → 월드 waypoint
    const cells: number[] = [];
    for (let k = found; k >= 0; k = g.prev[k]!) cells.push(k >> 2);
    cells.reverse();
    const cpt: Pt[] = cells.map((c) => [c % W, (c / W) | 0]);
    const turns: Pt[] = [cpt[0]!];
    for (let k = 1; k < cpt.length - 1; k++) {
      if (cpt[k]![0] - cpt[k - 1]![0] !== cpt[k + 1]![0] - cpt[k]![0] ||
          cpt[k]![1] - cpt[k - 1]![1] !== cpt[k + 1]![1] - cpt[k]![1]) turns.push(cpt[k]!);
    }
    if (cpt.length > 1) turns.push(cpt[cpt.length - 1]!);
    const wp: Pt[] = turns.map(([i, j]) => [g.x + i * CELL + CELL / 2, g.y + j * CELL + CELL / 2]);
    // 시작 스텁을 자식 행 높이에, 끝 스텁을 부모 진입 높이에 맞춘다 (wp 원소를 제자리 수정)
    if (wp.length > 1 && Math.abs(wp[0]![1] - cy) <= CELL) wp[0]![1] = cy;
    const last = wp[wp.length - 1]!;
    if (wp.length > 1 && Math.abs(last[1] - py) <= CELL) last[1] = py;
    wp.unshift([cx, cy]);
    wp.push([px, py]);
    return wp;
  }

  function roundedPath(wp: Pt[]): string {
    let d = `M${wp[0]![0]},${wp[0]![1]}`;
    for (let k = 1; k < wp.length - 1; k++) {
      const a = wp[k - 1]!, b = wp[k]!, c = wp[k + 1]!;
      const v1: Pt = [b[0] - a[0], b[1] - a[1]], v2: Pt = [c[0] - b[0], c[1] - b[1]];
      const l1 = Math.hypot(v1[0], v1[1]), l2 = Math.hypot(v2[0], v2[1]);
      if (!l1 || !l2) continue;
      const rr = Math.min(12, l1 / 2, l2 / 2);
      d += ` L${b[0] - (v1[0] / l1) * rr},${b[1] - (v1[1] / l1) * rr}` +
           ` Q${b[0]},${b[1]} ${b[0] + (v2[0] / l2) * rr},${b[1] + (v2[1] / l2) * rr}`;
    }
    d += ` L${wp[wp.length - 1]![0]},${wp[wp.length - 1]![1]}`;
    return d;
  }

  // 모든 관계선은 격자 직각(라운드 코너) 스타일로 통일 — 곡선/직각 혼재는 읽기를 방해한다.
  // 드래그 중(fastPreview)과 경로 탐색 실패 시에는 같은 스타일의 단순 엘보로 그린다.
  function routeEdge(cx: number, cy: number, px: number, py: number, parentRight: boolean): string {
    if (!fastPreview) {
      const wp = gridRoute(cx, cy, px, py, parentRight);
      if (wp) return roundedPath(wp);
    }
    return roundedPath(elbowWp(cx, cy, px, py));
  }

  function drawEdge(g: SVGGElement, r: Ref, meta: RefMeta): void {
    g.innerHTML = '';
    const c = pos[r.child.table], p = pos[r.parent.table];
    if (!c || !p) return;
    // dotX/dotY는 두 분기에서 각각 채운다 (원래 var로 호이스팅되던 자리)
    let d: string, ax: number, ay: number, tipDir: number, labX: number, labY: number, dotX: number, dotY: number;
    const col = r.child.cols[0];
    // 접힌 컬럼이라 rowY에 없으면 15(헤더 아래 기본 높이)로 떨어진다 — 정상 경로다
    const childRowY = (col ? c.rowY[col] : undefined) || 15;
    if (r.self) {
      const x = c.x + c.w, y1 = c.y + childRowY, y2 = c.y + 9;
      d = `M${x},${y1} C${x + 46},${y1} ${x + 46},${y2} ${x + 2},${y2}`;
      ax = x + 2; ay = y2; tipDir = -1; labX = x + 30; labY = (y1 + y2) / 2;
      dotX = x; dotY = y1;
    } else {
      const cy = c.y + childRowY;
      const py = p.y + 14;
      const parentRight = p.x + p.w / 2 >= c.x + c.w / 2;
      const cx = parentRight ? c.x + c.w : c.x;
      const px = parentRight ? p.x : p.x + p.w;
      d = routeEdge(cx, cy, px, py, parentRight);
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
  function redrawEdgesTouching(tname: string | null): void {
    for (const e of edgeEls) {
      if (!tname || e.ref.child.table === tname || e.ref.parent.table === tname) {
        drawEdge(e.el, e.ref, e.meta);
        hookEdge(e.el, e.ref, e.meta);
      }
    }
  }
  function redrawEdgesTouchingSet(set: Set<string>): void {
    for (const e of edgeEls) {
      if (set.has(e.ref.child.table) || set.has(e.ref.parent.table)) {
        drawEdge(e.el, e.ref, e.meta);
        hookEdge(e.el, e.ref, e.meta);
      }
    }
  }
  // 드래그 확정 후: 라우팅은 모든 노드 위치에 의존하므로 비인접 엣지까지 전부 재계산.
  // grid 무효화가 redrawEdgesTouching보다 반드시 먼저여야 새 위치로 A*가 다시 돈다.
  function settleAfterMove(): void {
    fastPreview = false;
    grid = null;
    redrawEdgesTouching(null);
    buildMinimap();
    if (ST().selected) select(ST().selected);
  }
  function hookEdge(g: SVGGElement, r: Ref, meta: RefMeta): void {
    const hit = g.querySelector<SVGPathElement>('.hit');
    if (!hit) return;
    hit.addEventListener('pointerenter', (ev) => {
      g.classList.add('hot');
      CB().tooltip.show(edgeTooltipHtml(r, meta), ev.clientX, ev.clientY);
    });
    hit.addEventListener('pointermove', (ev) => CB().tooltip.move(ev.clientX, ev.clientY));
    hit.addEventListener('pointerleave', () => { g.classList.remove('hot'); CB().tooltip.hide(); });
  }
  /** 관계 하나를 설명하는 칩 줄 — 관계선 툴팁(edgeTooltipHtml)과 컬럼 툴팁의 관계 블록(fkBlockHtml)이 함께 쓴다 */
  function relChipsHtml(r: Ref, meta: RefMeta): string {
    const ty = SEM().TYPES[meta.type];
    return `<div class="tt-chips">` +
      `<span class="ty" style="--c:var(${ty.cssVar})">${ty.label}</span>` +
      `<span class="kd">${meta.card}</span>` +
      `<span class="kd">${r.kind === 'real' ? '실 DB FK' : '논리 FK'}</span>` +
      `${r.onDelete ? `<span class="kd">on delete ${esc(r.onDelete)}</span>` : ''}` +
      `</div>`;
  }

  const ENUM_TIP_MAX = 12;

  /** FK 컬럼일 때만 붙는 관계 블록. 복합 FK의 후행 멤버는 어느 관계의 일부인지만 알린다 */
  function fkBlockHtml(f: ColumnFk): string {
    const r = f.ref;
    if (f.role === 'member') {
      return `<div class="tt-rel"><div class="tt-sub">복합 FK (${r.child.cols.map(esc).join(', ')}) → ` +
        `${esc(r.parent.table)}.(${r.parent.cols.map(esc).join(', ')})</div></div>`;
    }
    const meta = metaOf(r);
    return `<div class="tt-rel">${relChipsHtml(r, meta)}<b>${esc(meta.label)}</b> — ${esc(meta.sentence)}</div>`;
  }

  function colTooltipHtml(t: Table, c: Column): string {
    const head = `<div class="tt-head">${esc(t.name)}.${esc(c.name)}</div>`;
    const f = columnFacts(MODEL(), t.name, c.name);
    if (!f) return head; // 모델과 렌더가 어긋난 상태 — 이름만이라도 보여준다
    const chips: string[] = [];
    if (c.type) chips.push(`<span class="kd">${esc(c.type)}</span>`);
    if (c.pk) chips.push('<span class="kd">PK</span>');
    if (c.unique) chips.push('<span class="kd">UQ</span>');
    // PK는 파서가 notNull을 강제로 켠다 — 같은 사실을 두 칩으로 반복하지 않는다
    if (!c.pk) chips.push(`<span class="kd">${c.notNull ? 'NOT NULL' : 'NULL 허용'}</span>`);
    if (c.dflt != null) chips.push(`<span class="kd">기본값 ${esc(c.dflt)}</span>`);

    let h = head + `<div class="tt-chips">${chips.join('')}</div>`;
    if (c.note) h += `<div class="tt-sub">${esc(c.note)}</div>`;
    if (f.enumDef) {
      const vs = f.enumDef.values.map((v) => v.name);
      const head2 = vs.slice(0, ENUM_TIP_MAX).map(esc).join(' · ');
      const more = vs.length > ENUM_TIP_MAX ? ` … 외 ${vs.length - ENUM_TIP_MAX}개` : '';
      h += `<div class="tt-sub">허용 값: ${head2}${more}</div>`;
    }
    for (const ix of f.compositeUnique) {
      h += `<div class="tt-sub">복합 UNIQUE (${ix.map(esc).join(', ')})</div>`;
    }
    if (f.fk) h += fkBlockHtml(f.fk);
    return h;
  }

  const HUB_TIP_MAX = 8;

  // relChipsHtml을 그대로 쓰지 않는 이유: 그쪽은 칩을 <div class="tt-chips">로 감싸 줄바꿈하는데,
  // 허브 행은 "자식컬럼 → 허브.부모컬럼" 텍스트 뒤에 칩을 같은 줄로 이어 붙여야 해서 마크업을 따로 짠다.
  function hubTooltipHtml(child: string, hub: string, refs: Ref[]): string {
    const rows = refs.slice(0, HUB_TIP_MAX).map((r) => {
      const meta = metaOf(r);
      const ty = SEM().TYPES[meta.type];
      return `<div>${esc(r.child.cols.join(','))} → ${esc(hub)}.${esc(r.parent.cols.join(','))} ` +
        `<span class="ty" style="--c:var(${ty.cssVar})">${ty.label}</span>` +
        `<span class="kd">${meta.card}</span>` +
        `<span class="kd">${r.kind === 'real' ? '실 DB FK' : '논리 FK'}</span>` +
        `${r.onDelete ? `<span class="kd">on delete ${esc(r.onDelete)}</span>` : ''}</div>`;
    }).join('');
    const more = refs.length > HUB_TIP_MAX
      ? `<div class="tt-sub">… 외 ${refs.length - HUB_TIP_MAX}개</div>` : '';
    return `<div class="tt-head">${esc(child)} → ${esc(hub)}</div>` +
      `<div class="tt-sub">접힌 관계 ${refs.length}개</div>` +
      `<div class="tt-list">${rows}</div>${more}`;
  }

  /**
   * --tip/--tip-hub 캡처 전용: 지연을 건너뛰고 대상 위에 툴팁을 고정한다. 대상이 화면에 없으면 false.
   * 호출하면 tipForced를 영구히 true로 잠가 이후 모든 tipArm/tipCancel을 무력화한다 — 되돌리는
   * 수단이 없다. CLI는 매 실행이 새 프로세스라 문제없지만, 일반 UI 상호작용에 연결하면 그 세션 내내
   * 모든 툴팁이 조용히 죽는다. UI 경로에서 부르지 말 것.
   */
  function showTip(kind: 'col' | 'hub', table: string, key: string): boolean {
    const g = nodeEls[table];
    const t = MODEL().tables.find((x) => x.name === table);
    if (!g || !t) return false;
    if (kind === 'hub') {
      const hit = g.querySelector<SVGRectElement>(`rect[data-tip-hub="${CSS.escape(key)}"]`);
      const link = hubLinksFor(table).find((l) => l.hub === key);
      if (!hit || !link) return false;
      const r = hit.getBoundingClientRect();
      tipForced = true;
      CB().tooltip.show(hubTooltipHtml(table, key, link.refs), r.left + r.width / 2, r.bottom);
      return true;
    }
    const hit = g.querySelector<SVGRectElement>(`rect[data-tip-col="${CSS.escape(key)}"]`);
    const c = t.cols.find((x) => x.name === key);
    if (!hit || !c) return false; // 컬럼이 접혀 있으면 히트 사각형 자체가 없다
    const r = hit.getBoundingClientRect();
    tipForced = true;
    CB().tooltip.show(colTooltipHtml(t, c), r.left + r.width / 2, r.bottom);
    return true;
  }

  function edgeTooltipHtml(r: Ref, meta: RefMeta): string {
    return `<div class="tt-head">${esc(r.child.table)}.${esc(r.child.cols.join(','))} → ${esc(r.parent.table)}.${esc(r.parent.cols.join(','))}</div>` +
      relChipsHtml(r, meta) +
      `<b>${esc(meta.label)}</b> — ${esc(meta.sentence)}`;
  }

  // ── 지연 호버 툴팁 ──────────────────────────────────────
  // 관계선(hookEdge)은 즉시 표시 + 마우스 추종으로 충분하다 — 선이 얇아 겨냥 자체가 의도다.
  // 컬럼 행은 18px 간격으로 붙어 있어 같은 규칙을 쓰면 카드 위를 지나가기만 해도 툴팁이 튄다.
  // 그래서 카드 안쪽 대상만 "지연 후 고정"을 따로 쓴다.
  const TIP_DELAY = 300;      // 처음 뜰 때까지
  const TIP_WARM_DELAY = 100; // 방금 툴팁을 보고 있었으면 짧게 — 컬럼을 훑을 때 매번 기다리지 않게
  const TIP_WARM_MS = 400;
  let tipTimer = 0;           // 0 = 예약 없음 (setTimeout은 1부터 반환한다)
  let tipShown = false;
  let tipHiddenAt = Number.NEGATIVE_INFINITY;
  let tipForced = false;      // --tip/--tip-hub 캡처 모드 — 호버 경로가 툴팁을 건드리지 못하게 잠근다
  // 드래그(노드/그룹/팬) 도중엔 포인터 캡처와 무관하게 pointerenter/leave가 실제 좌표 기준으로 계속
  // 발생한다 — 300ms 안에 드래그가 끝나지 않으면 지나친 다른 카드의 행에서 툴팁이 떴다가 드롭 전에
  // 보이는 문제가 생긴다. hookViewport의 pointerdown/up과 짝을 맞춰 드래그 중엔 무조건 억제한다.
  let tipSuppressed = false;

  function tipArm(html: string, x: number, y: number): void {
    if (tipForced || tipSuppressed) return;
    if (tipTimer) clearTimeout(tipTimer);
    const warm = tipShown || performance.now() - tipHiddenAt < TIP_WARM_MS;
    tipTimer = window.setTimeout(() => {
      tipTimer = 0;
      tipShown = true;
      CB().tooltip.show(html, x, y); // 이후 move를 부르지 않는다 = 제자리 고정
    }, warm ? TIP_WARM_DELAY : TIP_DELAY);
  }

  function tipCancel(): void {
    if (tipForced) return;
    if (tipTimer) { clearTimeout(tipTimer); tipTimer = 0; }
    if (tipShown) { tipShown = false; tipHiddenAt = performance.now(); }
    cb?.tooltip.hide(); // render() 중에는 cb가 없을 수 있다
  }
  // 뷰포트 조작(휠 팬·드래그 시작·키보드/검색으로 인한 이동)에서 쓰는 절제판 — 우리(컬럼/허브) 툴팁이
  // 예약되었거나 표시 중일 때만 걷어낸다. hookEdge의 관계선 툴팁은 같은 #tooltip을 공유하지만
  // 자기 pointerleave에서만 hide()를 부른다. 여기서 무조건 tipCancel()을 부르면, 두 손가락
  // 스크롤(기본 팬 제스처) 중 관계선 위에 떠 있던 툴팁까지 꺼지고 pointermove는 move()만 불러
  // 되살리지 못한다 — 그래서 우리 상태가 없을 땐 손대지 않는다.
  function tipCancelViewport(): void {
    if (!tipShown && !tipTimer) return;
    tipCancel();
  }

  // ── 선택/하이라이트 ──────────────────────────────────────
  function select(name: string | null): void {
    ST().selected = name;
    SVG().classList.toggle('has-sel', !!name);
    const near = new Set<string>(name ? [name] : []);
    if (name) {
      for (const e of edgeEls) {
        if (ST().filter === 'real' && e.ref.kind === 'logical') continue;
        if (e.ref.child.table === name) near.add(e.ref.parent.table);
        if (e.ref.parent.table === name) near.add(e.ref.child.table);
      }
    }
    for (const tn in nodeEls) {
      nodeEls[tn]!.classList.toggle('sel', tn === name);
      nodeEls[tn]!.classList.toggle('dim', !!name && !near.has(tn));
    }
    for (const e of edgeEls) {
      const adj = !!name && (e.ref.child.table === name || e.ref.parent.table === name);
      e.el.classList.toggle('adj', adj);
      e.el.classList.toggle('dim', !!name && !adj);
    }
  }
  function applyHubToggles(): void {
    // 켜진 허브의 엣지만 hub-on — 허브별 독립 토글. 비허브 엣지는 dataset.hub가 빈 문자열이다
    for (const e of edgeEls) {
      const hub = e.el.dataset['hub'];
      if (hub) e.el.classList.toggle('hub-on', !!ST().hubShown[hub]);
    }
  }
  function applyFilter(): void { SVG().classList.toggle('filter-real', ST().filter === 'real'); if (ST().selected) select(ST().selected); }

  // ── 미니맵 ──────────────────────────────────────────────
  const MM = { w: 176, h: 120, pad: 6 };
  let mmSvg: SVGSVGElement | null = null, mmView: SVGRectElement | null = null;
  let mmScale = 1, mmBox: { x: number; y: number; w: number; h: number } | null = null, mmRaf = 0;

  function scheduleMinimap(): void {
    if (mmRaf) return; // 0 = 예약 없음 (rAF는 1부터 반환한다)
    mmRaf = requestAnimationFrame(() => { mmRaf = 0; buildMinimap(); });
  }

  function mountMinimap(): void {
    const mm = document.getElementById('minimap') as SVGSVGElement | null;
    mmSvg = mm;
    if (!mm) return;
    // 크기의 단일 출처는 MM 상수 — CSS에는 위치/외양만 둔다
    mm.setAttribute('viewBox', `0 0 ${MM.w} ${MM.h}`);
    mm.style.width = MM.w + 'px';
    mm.style.height = MM.h + 'px';
    mm.style.boxSizing = 'content-box';
    const jump = (e: PointerEvent): void => {
      const mr = mm.getBoundingClientRect(), r = SVG().getBoundingClientRect();
      const wx = (e.clientX - mr.left - mm.clientLeft - MM.pad) / mmScale + mmBox!.x;
      const wy = (e.clientY - mr.top - mm.clientTop - MM.pad) / mmScale + mmBox!.y;
      tf.x = r.width / 2 - wx * tf.k;
      tf.y = r.height / 2 - wy * tf.k;
      applyTf();
    };
    let dragging = false;
    mm.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !mmBox) return;
      dragging = true; mm.setPointerCapture(e.pointerId); jump(e);
    });
    mm.addEventListener('pointermove', (e) => { if (dragging) jump(e); });
    mm.addEventListener('pointerup', () => { dragging = false; });
    mm.addEventListener('pointercancel', () => { dragging = false; });
    mm.addEventListener('lostpointercapture', () => { dragging = false; });
    window.addEventListener('resize', updateMinimapView);
  }
  function buildMinimap(): void {
    if (!mmSvg || !model) return;
    mmBox = contentBBox();
    // !(x > 0)은 0·음수뿐 아니라 NaN까지 걸러내려는 형태다 — <= 0 으로 바꾸지 말 것
    if (!(mmBox.w > 0) || !(mmBox.h > 0)) { mmSvg.innerHTML = ''; mmView = null; mmBox = null; return; }
    mmScale = Math.min((MM.w - MM.pad * 2) / mmBox.w, (MM.h - MM.pad * 2) / mmBox.h);
    mmSvg.innerHTML = '';
    for (const t of model.tables) {
      const p = pos[t.name]; if (!p) continue;
      el('rect', {
        class: 'mm-node',
        x: MM.pad + (p.x - mmBox.x) * mmScale, y: MM.pad + (p.y - mmBox.y) * mmScale,
        width: Math.max(2, p.w * mmScale), height: Math.max(2, p.h * mmScale),
        style: `fill:var(${ST().groupColor[t.group ?? ''] || '--gc-x'})`,
      }, mmSvg);
    }
    mmView = el('rect', { class: 'mm-view', rx: 2 }, mmSvg);
    updateMinimapView();
  }
  function updateMinimapView(): void {
    if (!mmView || !mmBox) return;
    const r = SVG().getBoundingClientRect();
    if (!r.width) return;
    mmView.setAttribute('x', String(MM.pad + (-tf.x / tf.k - mmBox.x) * mmScale));
    mmView.setAttribute('y', String(MM.pad + (-tf.y / tf.k - mmBox.y) * mmScale));
    mmView.setAttribute('width', String((r.width / tf.k) * mmScale));
    mmView.setAttribute('height', String((r.height / tf.k) * mmScale));
  }

  // ── 뷰포트 ──────────────────────────────────────────────
  function contentBBox(): { x: number; y: number; w: number; h: number } {
    let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
    for (const k in pos) {
      const b = pos[k]!;
      x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
      x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
    }
    return { x: x1 - 30, y: y1 - 50, w: x2 - x1 + 60, h: y2 - y1 + 80 };
  }
  function fit(): void {
    tipCancelViewport(); // 화면 전체가 움직이므로 고정된 툴팁이 엉뚱한 자리에 떠 있으면 안 된다
    const b = contentBBox(), r = SVG().getBoundingClientRect();
    if (b.w <= 0) return;
    if (!r.width || !r.height) { pendingFit = true; return; } // 숨겨진 상태(포커스 모드)에서 scale 0 방지
    pendingFit = false;
    const k = Math.min(r.width / b.w, r.height / b.h, 1);
    tf = { k, x: (r.width - b.w * k) / 2 - b.x * k, y: (r.height - b.h * k) / 2 - b.y * k };
    applyTf();
  }
  function fitIfPending(): void { if (pendingFit) fit(); else updateMinimapView(); } // 숨김 중 리사이즈로 스테일해진 미니맵 뷰포트 보정
  function centerOn(name: string): void {
    const p = pos[name]; if (!p) return;
    tipCancelViewport(); // 검색 등으로 다른 테이블로 점프 — 이전 위치에 고정된 툴팁을 남기지 않는다
    const r = SVG().getBoundingClientRect();
    tf.x = r.width / 2 - (p.x + p.w / 2) * tf.k;
    tf.y = r.height / 2 - (p.y + p.h / 2) * tf.k;
    applyTf();
  }

  type Drag =
    | { type: 'pan'; sx: number; sy: number; ox: number; oy: number; moved: boolean }
    | { type: 'node'; name: string; group: string | null; sx: number; sy: number; ox: number; oy: number; moved: boolean }
    | {
        type: 'group'; members: string[]; sx: number; sy: number; moved: boolean;
        orig: Record<string, { x: number; y: number }>;
        hullEls: { n: Element; x: number; y: number }[];
      };

  function hookViewport(): void {
    const sv = SVG();
    sv.addEventListener('wheel', (e) => {
      tipCancelViewport();
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const k2 = Math.min(2.5, Math.max(0.12, tf.k * Math.exp(-e.deltaY * 0.01)));
        const r = sv.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        tf.x = mx - ((mx - tf.x) / tf.k) * k2;
        tf.y = my - ((my - tf.y) / tf.k) * k2;
        tf.k = k2;
      } else { tf.x -= e.deltaX; tf.y -= e.deltaY; }
      applyTf();
    }, { passive: false });

    let drag: Drag | null = null;
    sv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // 우클릭 드래그/선택 방지
      tipCancelViewport();
      tipSuppressed = true; // 드롭(pointerup)까지 새 툴팁 예약을 막는다
      const tgt = e.target instanceof Element ? e.target : null;
      const nodeG = tgt?.closest<SVGGElement>('.node') ?? null;
      const hullG = !nodeG ? tgt?.closest<SVGGElement>('.hullg') ?? null : null;
      if (nodeG) {
        const name = nodeG.dataset['name'] ?? '';
        const p = pos[name];
        // pos 조회를 fastPreview 대입보다 먼저 — 조기 return 하면 fastPreview가 true로 고착된다
        if (p) {
          const t = MODEL().tables.find((x) => x.name === name);
          fastPreview = true; // 드래그 중엔 빠른 곡선 미리보기, 확정 시 전체 재라우팅
          drag = { type: 'node', name, group: t?.group ?? null, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false };
        }
      } else if (hullG) {
        // 그룹(헐) 드래그: 멤버 테이블 전체를 한 단위로 이동
        fastPreview = true;
        const gname = hullG.dataset['group'] ?? '';
        const members = MODEL().tables.filter((t) => t.group === gname && pos[t.name]).map((t) => t.name);
        drag = {
          type: 'group', members, sx: e.clientX, sy: e.clientY, moved: false,
          orig: Object.fromEntries(members.map((m) => [m, { x: pos[m]!.x, y: pos[m]!.y }])),
          hullEls: [...hullG.querySelectorAll<SVGElement>('rect,text')].map((n) => ({ n, x: +(n.getAttribute('x') ?? ''), y: +(n.getAttribute('y') ?? '') })),
        };
      } else if (!tgt?.closest('.edge')) {
        drag = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: tf.x, oy: tf.y, moved: false };
        sv.classList.add('panning');
      }
      sv.setPointerCapture(e.pointerId);
    });
    sv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.type === 'pan') { tf.x = drag.ox + dx; tf.y = drag.oy + dy; applyTf(); }
      else if (drag.type === 'group') {
        const dxk = dx / tf.k, dyk = dy / tf.k;
        for (const m of drag.members) {
          // members는 pos에 있는 이름만 모았고, nodeEls도 같은 렌더에서 채워진다
          const p = pos[m]!, o = drag.orig[m]!, g = nodeEls[m]!;
          p.x = o.x + dxk; p.y = o.y + dyk;
          g.setAttribute('transform', `translate(${p.x},${p.y})`);
        }
        for (const h of drag.hullEls) { h.n.setAttribute('x', String(h.x + dxk)); h.n.setAttribute('y', String(h.y + dyk)); }
        redrawEdgesTouchingSet(new Set(drag.members));
        scheduleMinimap();
      }
      else {
        const p = pos[drag.name]!;
        p.x = drag.ox + dx / tf.k; p.y = drag.oy + dy / tf.k;
        nodeEls[drag.name]!.setAttribute('transform', `translate(${p.x},${p.y})`);
        redrawEdgesTouching(drag.name);
        if (drag.group) updateHull(drag.group);
        scheduleMinimap();
      }
    });
    sv.addEventListener('pointerup', () => {
      tipSuppressed = false; // 드래그 종료 — 이후 호버는 다시 정상적으로 툴팁을 예약한다
      if (!drag) return;
      if (drag.type === 'node') {
        if (!drag.moved) { fastPreview = false; CB().onSelect(drag.name === ST().selected ? null : drag.name); }
        else { customLayout = true; savePositions(); settleAfterMove(); }
      } else if (drag.type === 'group') {
        if (!drag.moved) { fastPreview = false; CB().onSelect(null); }
        else { customLayout = true; savePositions(); settleAfterMove(); }
      } else if (drag.type === 'pan' && !drag.moved) CB().onSelect(null);
      sv.classList.remove('panning');
      drag = null;
    });
    // 미니맵(mountMinimap)과 같은 이유: OS 제스처 중단·창 포커스 이탈로 pointerup이 오지 않으면
    // tipSuppressed가 true로 영구히 고착되어 세션 내내 툴팁이 뜨지 않는다. 드래그 상태도 pointerup과
    // 같은 수준으로 정리하되(전체 재라우팅·저장 같은 "확정" 절차는 완결된 제스처가 아니므로 생략한다).
    sv.addEventListener('pointercancel', () => {
      tipSuppressed = false;
      if (!drag) return;
      fastPreview = false;
      sv.classList.remove('panning');
      drag = null;
    });
    sv.addEventListener('dblclick', (e) => {
      const tgt = e.target instanceof Element ? e.target : null;
      const nodeG = tgt?.closest<SVGGElement>('.node') ?? null;
      if (nodeG) CB().onOpenFocus(nodeG.dataset['name'] ?? '');
    });
  }

  // ── 공개 API ────────────────────────────────────────────
  return {
    mount(svgEl: SVGSVGElement, callbacks: Callbacks): void { svg = svgEl; cb = callbacks; hookViewport(); mountMinimap(); },
    async load(m: Model, s: Analysis, state: AppState): Promise<void> {
      model = m; sem = s; S = state;
      loadLayoutMode();
      await computeLayout();
      render();
      fit();
      applyFilter();
      if (S.selected) select(S.selected);
    },
    rerender(): void { render(); if (ST().selected) select(ST().selected); applyFilter(); },
    select, fit, fitIfPending, centerOn, applyFilter, applyHubToggles,
    async resetLayout(): Promise<void> { if (!model) return; clearPositions(); await computeLayout(); render(); fit(); applyFilter(); if (ST().selected) select(ST().selected); },
    // 하단 정렬 바: 방식 변경 → 커스텀 배치 폐기, 재배치 후 저장(재시작에도 유지)
    async arrange(mode: string | null | undefined): Promise<void> {
      if (!model || !isMode(mode)) return;
      layoutMode = mode;
      try { localStorage.setItem(layStoreKey(), mode); } catch {}
      clearPositions();
      await computeLayout();
      savePositions();
      render(); fit(); applyFilter();
      if (ST().selected) select(ST().selected);
    },
    showTip, // CLI --tip/--tip-hub 전용 — 한 번 호출하면 tipForced가 영구히 잠기고 리셋 수단이 없다. UI에 연결 금지
    getLayoutMode: (): LayoutMode => layoutMode,
    hasCustomLayout: (): boolean => customLayout,
  };
})();
