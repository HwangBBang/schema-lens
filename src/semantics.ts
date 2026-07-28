// 의미 레이어: 파싱된 모델(JSON)에서 관계 유형·카디널리티·조인테이블·허브를 휴리스틱으로 도출.
// 순수 함수, 의존성 없음 — Node(검증 스크립트)와 브라우저(renderer) 양쪽에서 로드된다.
//
// DBML 표준에 없는 정보를 다음 규칙으로 추론한다:
//  - 관계 유형 8종: 컬럼명 패턴 + self-ref + cascade + PK 멤버십
//  - 카디널리티: `-`(1:1) 또는 unique FK → 1:1, 그 외 N:1, 조인테이블 → N:M
//  - 조인테이블: 복합 PK 전체가 FK / FK 2개 + 부가 컬럼 소수
//  - 허브: 유입 엣지가 많고 그 대부분이 사람-유형(own/req/auth/share/ment)인 테이블(예: users)
//    → ERD에서 엣지를 접고 칩으로 대체해 "구조"가 보이게 한다.


import type { Model, Ref, RefKind } from './model.ts';
/** inferType이 모델을 되묻는 창구. analyze 안에서 한 번 만들어 넘긴다. */
type Ctx = {
  isJunction(t: string): boolean;
  junctionPrimary(t: string, parent: string): boolean;
  colInPk(t: string, col: string): boolean;
  colNotNull(t: string, col: string): boolean;
  sameGroup(a: string, b: string): boolean;
};


export type RelType = 'comp' | 'own' | 'req' | 'auth' | 'share' | 'ment' | 'hier' | 'ref';
export type Cardinality = 'N:M' | '1:1' | 'N:1';

export type ActionName = 'cascade' | 'set null' | 'set default' | 'restrict' | 'no action' | 'unknown';
export type Action = { action: ActionName; specified: boolean; raw: string | null };

export type RefMeta = {
  type: RelType;
  card: Cardinality;
  label: string;
  sentence: string;
  onDelete: Action;
  onUpdate: Action;
};

/** 조인테이블이면 양끝 테이블 쌍, 다대상 링크면 null */
export type Junction = [string, string] | null;

export type TableMeta = {
  outDegree: number;
  inDegree: number;
  degree: number;
  junction: Junction | 'multi';
  selfRef: boolean;
};

export type Hub = { table: string; inDegree: number };

export type Analysis = {
  TYPES: typeof TYPES;
  refMeta: Record<string, RefMeta>;
  tableMeta: Record<string, TableMeta>;
  junctions: Record<string, Junction>;
  hubs: Hub[];
};

/** 삭제 영향 추적에서 관계 하나가 만들어내는 항목 */
export type ImpactEntry = {
  refId: string;
  table: string;
  via: string[];
  action: ActionName;
  specified: boolean;
  raw: string | null;
  kind: RefKind;
  guaranteed: boolean;
  depth: number;
  veto: boolean;
  warning: string | null;
  cycle: boolean;
  orphan: boolean;
  dedup?: boolean;
  children: ImpactEntry[];
};

export type Veto = { refId: string; table: string; via: string[]; reason: string };

export type ImpactSummary = {
  guaranteed: { cascade: string[]; setNull: string[]; setDefault: string[]; blocked: string[] };
  app: { cascade: string[]; setNull: string[]; orphan: string[] };
  maxDepth: number;
};

export type Impact = { entries: ImpactEntry[]; vetoed: Veto[]; summary: ImpactSummary };


const TYPES = {
  comp:  { label: '소속',      cssVar: '--t-comp' },
  own:   { label: '소유·담당', cssVar: '--t-own' },
  req:   { label: '요청',      cssVar: '--t-req' },
  auth:  { label: '작성·행위', cssVar: '--t-auth' },
  share: { label: '공유·참여', cssVar: '--t-share' },
  ment:  { label: '멘션',      cssVar: '--t-ment' },
  hier:  { label: '계층',      cssVar: '--t-hier' },
  ref:   { label: '참조',      cssVar: '--t-ref' },
};

const META_COL = /^(id|created_at|updated_at|deleted_at|joined_at|sort_order|created_by|updated_by)$/;

// ---- 삭제 액션(referential action) ----
// DBML/SQL 표준 5종 + unknown. 판정·집계는 no action(명시)과 미지정을 동치 취급하고,
// specified 플래그로 표시 층위에서만 구분한다.
const ACTIONS = {
  'cascade':     { label: '연쇄 삭제',   cssVar: '--act-cascade' },
  'set null':    { label: 'NULL 전환',   cssVar: '--act-setnull' },
  'set default': { label: '기본값 전환', cssVar: '--act-setnull' },
  'restrict':    { label: '삭제 차단',   cssVar: '--act-restrict' },
  'no action':   { label: '기본 동작',   cssVar: '--act-restrict' },
  'unknown':     { label: '알 수 없음',  cssVar: '--act-restrict' },
};

// 원문 액션 문자열 → {action, specified, raw}. 대소문자·공백 변형 흡수, 전역(total) 분류.
function actionOf(raw: unknown): Action {
  if (raw == null || String(raw).trim() === '') return { action: 'no action', specified: false, raw: null };
  const norm = String(raw).trim().toLowerCase().replace(/[\s_]+/g, ' ');
  const action = (norm in ACTIONS && norm !== 'unknown' ? norm : 'unknown') as ActionName;
  return { action, specified: true, raw: String(raw) };
}

// "root 테이블의 행을 삭제하면 무슨 일이 일어나는가" — 유입(피참조) 방향 전이 추적.
// - 실 FK: cascade만 재귀 전파. set null/set default는 행 생존 종단.
//   set null인데 FK 컬럼에 NOT NULL이 있으면 삭제 자체가 실패 → 거부권.
//   restrict·미지정·unknown은 루트 삭제 전체에 대한 거부권(vetoed).
// - 논리 ref: 앱 레벨 격리 분기(guaranteed:false) — DB가 강제하지 않으므로 거부권 절대 불포함.
//   [delete:] 표기가 있으면 앱 의도로 전파, 무표기는 고아 가능 종단.
// - 순환 차단은 전역 visited가 아니라 path-local stack: 종단으로 스친 테이블도
//   다른 cascade 경로로 실제 삭제 대상이 되면 재확장해야 하위 거부권을 놓치지 않는다
//   (다이아몬드 경로). 확장 중복 방지는 (table, db|app) 키로 분리.
// - 유입 인접은 표시용 inRefs(self 제외)와 달리 self-loop 포함(자체 구성).
function deleteImpact(model: Model, root: string): Impact {
  const byName = new Map(model.tables.map((t) => [t.name, t]));
  const incoming = new Map<string, Ref[]>();
  for (const r of model.refs) {
    const list = incoming.get(r.parent.table);
    if (list) list.push(r); else incoming.set(r.parent.table, [r]);
  }

  const vetoed: Veto[] = [];
  const cat = {
    guaranteed: { cascade: new Set<string>(), setNull: new Set<string>(), setDefault: new Set<string>(), blocked: new Set<string>() },
    app: { cascade: new Set<string>(), setNull: new Set<string>(), orphan: new Set<string>() },
  };
  let maxDepth = 0;
  const expanded = new Set<string>();

  function descend(entry: ImpactEntry, child: string, depth: number, guaranteed: boolean, stack: Set<string>): void {
    if (stack.has(child)) { entry.cycle = true; return; }
    const key = child + '|' + (guaranteed ? 'db' : 'app');
    if (expanded.has(key)) { entry.dedup = true; return; }
    expanded.add(key);
    stack.add(child);
    entry.children = expand(child, depth + 1, guaranteed, stack);
    stack.delete(child);
  }

  function expand(table: string, depth: number, guaranteed: boolean, stack: Set<string>): ImpactEntry[] {
    const entries: ImpactEntry[] = [];
    for (const r of incoming.get(table) || []) {
      const meta = actionOf(r.onDelete);
      const child = r.child.table;
      const entry: ImpactEntry = {
        refId: r.id, table: child, via: r.child.cols.slice(),
        action: meta.action, specified: meta.specified, raw: meta.raw,
        kind: r.kind, guaranteed, depth, veto: false, warning: null,
        cycle: false, orphan: false, children: [],
      };
      if (depth > maxDepth) maxDepth = depth;
      const fkCols = (byName.get(child) || { cols: [] }).cols.filter((c) => r.child.cols.includes(c.name));

      if (r.kind === 'logical') {
        if (!meta.specified) { entry.orphan = true; cat.app.orphan.add(child); }
        else if (meta.action === 'cascade') {
          cat.app.cascade.add(child);
          descend(entry, child, depth, false, stack);
        } else if (meta.action === 'set null' || meta.action === 'set default') {
          cat.app.setNull.add(child);
        }
        // restrict 등 그 외 표기는 표시만 — 전파·거부권 없음
      } else if (meta.action === 'cascade') {
        (guaranteed ? cat.guaranteed.cascade : cat.app.cascade).add(child);
        descend(entry, child, depth, guaranteed, stack);
      } else if (meta.action === 'set null') {
        const notNull = fkCols.find((c) => c.notNull);
        if (notNull) {
          entry.veto = true;
          entry.warning = `NOT NULL(${notNull.name}) — 삭제 실패`;
          if (guaranteed) {
            vetoed.push({ refId: r.id, table: child, via: entry.via, reason: 'not-null' });
            cat.guaranteed.blocked.add(child);
          }
        } else (guaranteed ? cat.guaranteed.setNull : cat.app.setNull).add(child);
      } else if (meta.action === 'set default') {
        const missing = fkCols.find((c) => c.dflt == null);
        if (missing) entry.warning = `기본값 없음(${missing.name}) — 삭제 실패 가능`;
        (guaranteed ? cat.guaranteed.setDefault : cat.app.setNull).add(child);
      } else { // restrict / no action(명시·미지정) / unknown
        entry.veto = true;
        if (guaranteed) {
          vetoed.push({ refId: r.id, table: child, via: entry.via, reason: meta.specified ? meta.action : 'unspecified' });
          cat.guaranteed.blocked.add(child);
        }
      }
      entries.push(entry);
    }
    return entries;
  }

  const entries = expand(root, 1, true, new Set([root]));
  const arr = (s: Set<string>): string[] => Array.from(s);
  return {
    entries, vetoed,
    summary: {
      guaranteed: {
        cascade: arr(cat.guaranteed.cascade), setNull: arr(cat.guaranteed.setNull),
        setDefault: arr(cat.guaranteed.setDefault), blocked: arr(cat.guaranteed.blocked),
      },
      app: { cascade: arr(cat.app.cascade), setNull: arr(cat.app.setNull), orphan: arr(cat.app.orphan) },
      maxDepth,
    },
  };
}

function inferType(ref: Ref, ctx: Ctx): RelType {
  const col = (ref.child.cols[0] || '').toLowerCase();
  const childTable = ref.child.table.toLowerCase();
  const parentTable = ref.parent.table.toLowerCase();

  if (ref.self || col === 'parent_id') return 'hier';
  if (/(created_by|updated_by|resolved_by|synthesized_by|uploaded_by|reviewed_by|approved_by|author|actor|writer|editor)/.test(col)) return 'auth';
  if (/(owner|assignee|account)/.test(col)) return 'own';
  if (/(requester|requested_by)/.test(col)) return 'req';
  if (/mention/.test(col)) return 'ment';
  if (/(watcher|principal|subscriber|shared|participant|member)/.test(col) ||
      (ctx.isJunction(ref.child.table) && /(^user_id$|^person_id$)/.test(col) && !ctx.junctionPrimary(ref.child.table, ref.parent.table)))
    return 'share';
  // 소속(구성요소) 신호: cascade 삭제 / FK가 PK 일부 / 자식 이름이 부모 이름을 접두로 가짐
  if (actionOf(ref.onDelete).action === 'cascade') return 'comp';
  if (ctx.colInPk(ref.child.table, ref.child.cols[0] ?? '')) return 'comp';
  const norm = (s: string): string => s.replace(/ies$/, 'y').replace(/s$/, '');
  const parentBase = norm(parentTable);
  if (childTable.startsWith(parentTable + '_') || childTable.startsWith(parentBase + '_')) return 'comp';
  const colBase = col.replace(/_id$/, '');
  if (colBase && colBase !== col && norm(parentTable).endsWith(norm(colBase))) {
    // 이름 계열이 일치하는 *_id
    if (/(^users?$|account|person)/.test(parentTable)) return 'own';
    // 필수(not null)이거나 같은 그룹이면 구성요소, 아니면(옵션 참조) 마스터 참조
    if (ctx.colNotNull(ref.child.table, ref.child.cols[0] ?? '') || ctx.sameGroup(ref.child.table, ref.parent.table))
      return 'comp';
  }
  return 'ref';
}

function sentence(type: RelType, ref: Ref, card: Cardinality): string {
  const c = ref.child.table, p = ref.parent.table;
  switch (type) {
    case 'comp':  return `${c} ${card === '1:1' ? '1건' : '여러 건'}이 ${p} 하나에 소속되는 구성요소`;
    case 'own':   return `${p}을(를) 소유·담당하는 주체 참조`;
    case 'req':   return `${p} 중 이 레코드를 요청한 대상`;
    case 'auth':  return `${p} 중 이 레코드를 작성·수정·실행한 대상`;
    case 'share': return `${p} 중 이 레코드를 공유·관찰·구독·리액션한 대상`;
    case 'ment':  return `${p} 중 이 레코드에서 멘션된 대상`;
    case 'hier':  return ref.self ? `자기 자신을 부모로 참조하는 트리 계층` : `${p}을(를) 상위로 두는 계층 관계`;
    default:      return `${p}을(를) 가리키는 마스터/엔티티 참조`;
  }
}

const DEFAULT_LABEL = {
  comp: '소속', own: '소유·담당', req: '요청자', auth: '작성·행위자',
  share: '공유·참여', ment: '멘션 대상', hier: '상위', ref: '참조',
};

// 컬럼 note에서 짧은 의미 라벨 추출: '담당자 → users.id (logical)' → '담당자'
// 'V79.', 'UNIQUE (…)', '비 PK,', 'uq_…' 같은 버전/제약 메타 토큰은 걷어낸다.
function labelFromNote(note: unknown): string | null {
  if (!note) return null;
  let s = String(note).trim(), prev: string;
  do {
    prev = s;
    s = s.replace(
      /^\s*(v\d[\w\/]*[.,;:]?\s+|unique(\s*\([^)]*\))?[.,;:—–-]*\s*|비\s*pk[.,;:]?\s*|(uq|uk|idx|ix)_\w+\s*[—–-]*\s*|부분\s*유니크(\s*\([^)]*\))?\s*(where[^.]*)?[.,;:—–-]*\s*)/i,
      ''
    );
  } while (s !== prev);
  const head = (s.split(/[→(.;,—–]/)[0] ?? '').trim();
  if (!head || head.length < 2 || head.length > 14) return null;
  if (/^(v\d|unique|pk|fk|not\s*null|index|on\s)/i.test(head)) return null;
  if (/유니크|인덱스/.test(head)) return null;
  if (!/[가-힣a-z]/i.test(head)) return null;
  return head;
}

function analyze(model: Model): Analysis {
  const byName = new Map(model.tables.map((t) => [t.name, t]));
  const outRefs = new Map<string, Ref[]>(); // child table → refs
  const inRefs = new Map<string, Ref[]>();  // parent table → refs (self 제외)
  for (const r of model.refs) {
    const outs = outRefs.get(r.child.table);
    if (outs) outs.push(r); else outRefs.set(r.child.table, [r]);
    if (!r.self) {
      const ins = inRefs.get(r.parent.table);
      if (ins) ins.push(r); else inRefs.set(r.parent.table, [r]);
    }
  }

  // ---- 조인테이블(N:M) 판별 ----
  const norm = (s: string): string => s.toLowerCase().replace(/ies$/, 'y').replace(/s$/, '');
  const junctions: Record<string, Junction> = Object.create(null); // table → [endA, endB] | null(다대상 링크)
  for (const t of model.tables) {
    const fks = (outRefs.get(t.name) || []).filter((r) => !r.self);
    if (fks.length < 2) continue;
    const fkColSet = new Set(fks.flatMap((r) => r.child.cols));
    const pkSet = new Set(t.pkCols);
    const pkFkRefs = fks.filter((r) => pkSet.has(r.child.cols[0] ?? ''));
    // 강한 신호: 복합 PK의 FK 컬럼이 2개 이상
    if (t.pkCols.length >= 2 && pkFkRefs.length >= 2) {
      junctions[t.name] = [pkFkRefs[0]!.parent.table, pkFkRefs[1]!.parent.table]; // 바로 위에서 2개 이상 확인
      continue;
    }
    // 중간 신호: FK 정확히 2개 + 부가(payload) 컬럼 3개 이하.
    // 오탐 방지: payload가 있으면 테이블명이 부모명에서 파생된 경우만
    // (team_members, issue_watchers처럼 A_역할 꼴). orders 같은 독립 엔티티 배제.
    const payload = t.cols.filter(
      (c) => !fkColSet.has(c.name) && !META_COL.test(c.name) && !/tenant/.test(c.name)
    );
    if (fks.length === 2 && payload.length <= 3) {
      const nameLinked = fks.some((r) => t.name.toLowerCase().startsWith(norm(r.parent.table) + '_'));
      if (payload.length === 0 || nameLinked) {
        junctions[t.name] = [fks[0]!.parent.table, fks[1]!.parent.table]; // fks.length === 2 분기 안
        continue;
      }
    }
    // 약한 신호: FK 3개 이상 + payload 1개 이하 → 다대상 링크 테이블
    if (fks.length >= 3 && payload.length <= 1) junctions[t.name] = null;
  }

  const ctx = {
    isJunction: (t: string) => t in junctions,
    junctionPrimary: (t: string, parent: string) => {
      const j = junctions[t];
      return !!j && j[0] === parent;
    },
    colInPk: (t: string, col: string) => {
      const tb = byName.get(t);
      return !!tb && tb.pkCols.length > 0 && tb.pkCols.includes(col) && tb.pkCols.length > 1;
    },
    colNotNull: (t: string, col: string) => {
      const tb = byName.get(t);
      const c = tb && tb.cols.find((x) => x.name === col);
      return !!c && c.notNull;
    },
    sameGroup: (a: string, b: string) => {
      const ta = byName.get(a), tb = byName.get(b);
      return !!ta && !!tb && !!ta.group && ta.group === tb.group;
    },
  };

  // ---- ref별 메타 ----
  const refMeta: Record<string, RefMeta> = Object.create(null);
  for (const r of model.refs) {
    const type = inferType(r, ctx);
    const childT = byName.get(r.child.table);
    const childCol = childT && childT.cols.find((c) => c.name === r.child.cols[0]);
    const card = r.manyToMany ? 'N:M' : (r.oneToOne || (childCol && childCol.unique)) ? '1:1' : 'N:1';
    refMeta[r.id] = {
      type,
      card,
      label: labelFromNote(childCol && childCol.note) || DEFAULT_LABEL[type],
      sentence: sentence(type, r, card),
      onDelete: actionOf(r.onDelete),
      onUpdate: actionOf(r.onUpdate),
    };
  }

  // ---- 허브 판별 ----
  const PERSON = new Set(['own', 'req', 'auth', 'share', 'ment']);
  const hubs: Hub[] = [];
  for (const t of model.tables) {
    const inc = inRefs.get(t.name) || [];
    if (inc.length < 8) continue;
    const personCount = inc.filter((r) => PERSON.has(refMeta[r.id]?.type ?? '')).length;
    if (personCount / inc.length >= 0.6) hubs.push({ table: t.name, inDegree: inc.length });
  }
  // tenant류 명시 허브(엣지가 있다면)
  for (const t of model.tables) {
    const inc = inRefs.get(t.name) || [];
    if (/^tenants?$/.test(t.name) && inc.length >= 5 && !hubs.some((h) => h.table === t.name))
      hubs.push({ table: t.name, inDegree: inc.length });
  }

  const tableMeta: Record<string, TableMeta> = Object.create(null);
  for (const t of model.tables) {
    const out = (outRefs.get(t.name) || []).filter((r) => !r.self).length;
    const inc = (inRefs.get(t.name) || []).length;
    tableMeta[t.name] = {
      outDegree: out,
      inDegree: inc,
      degree: out + inc,
      junction: t.name in junctions ? junctions[t.name] || 'multi' : null,
      selfRef: (outRefs.get(t.name) || []).some((r) => r.self),
    };
  }

  return { TYPES, refMeta, tableMeta, junctions, hubs };
}

export { analyze, TYPES, ACTIONS, actionOf, deleteImpact };
