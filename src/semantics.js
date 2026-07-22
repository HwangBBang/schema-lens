// 의미 레이어: 파싱된 모델(JSON)에서 관계 유형·카디널리티·조인테이블·허브를 휴리스틱으로 도출.
// 순수 함수, 의존성 없음 — Node(검증 스크립트)와 브라우저(renderer) 양쪽에서 로드된다.
//
// DBML 표준에 없는 정보를 다음 규칙으로 추론한다:
//  - 관계 유형 8종: 컬럼명 패턴 + self-ref + cascade + PK 멤버십
//  - 카디널리티: `-`(1:1) 또는 unique FK → 1:1, 그 외 N:1, 조인테이블 → N:M
//  - 조인테이블: 복합 PK 전체가 FK / FK 2개 + 부가 컬럼 소수
//  - 허브: 유입 엣지가 많고 그 대부분이 사람-유형(own/req/auth/share/ment)인 테이블(예: users)
//    → ERD에서 엣지를 접고 칩으로 대체해 "구조"가 보이게 한다.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Semantics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
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

  function inferType(ref, ctx) {
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
    if (ref.onDelete === 'cascade') return 'comp';
    if (ctx.colInPk(ref.child.table, ref.child.cols[0])) return 'comp';
    const norm = (s) => s.replace(/ies$/, 'y').replace(/s$/, '');
    const parentBase = norm(parentTable);
    if (childTable.startsWith(parentTable + '_') || childTable.startsWith(parentBase + '_')) return 'comp';
    const colBase = col.replace(/_id$/, '');
    if (colBase && colBase !== col && norm(parentTable).endsWith(norm(colBase))) {
      // 이름 계열이 일치하는 *_id
      if (/(^users?$|account|person)/.test(parentTable)) return 'own';
      // 필수(not null)이거나 같은 그룹이면 구성요소, 아니면(옵션 참조) 마스터 참조
      if (ctx.colNotNull(ref.child.table, ref.child.cols[0]) || ctx.sameGroup(ref.child.table, ref.parent.table))
        return 'comp';
    }
    return 'ref';
  }

  function sentence(type, ref, card) {
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
  function labelFromNote(note) {
    if (!note) return null;
    let s = note.trim(), prev;
    do {
      prev = s;
      s = s.replace(
        /^\s*(v\d[\w\/]*[.,;:]?\s+|unique(\s*\([^)]*\))?[.,;:—–-]*\s*|비\s*pk[.,;:]?\s*|(uq|uk|idx|ix)_\w+\s*[—–-]*\s*|부분\s*유니크(\s*\([^)]*\))?\s*(where[^.]*)?[.,;:—–-]*\s*)/i,
        ''
      );
    } while (s !== prev);
    const head = s.split(/[→(.;,—–]/)[0].trim();
    if (!head || head.length < 2 || head.length > 14) return null;
    if (/^(v\d|unique|pk|fk|not\s*null|index|on\s)/i.test(head)) return null;
    if (/유니크|인덱스/.test(head)) return null;
    if (!/[가-힣a-z]/i.test(head)) return null;
    return head;
  }

  function analyze(model) {
    const byName = new Map(model.tables.map((t) => [t.name, t]));
    const outRefs = new Map(); // child table → refs
    const inRefs = new Map();  // parent table → refs (self 제외)
    for (const r of model.refs) {
      if (!outRefs.has(r.child.table)) outRefs.set(r.child.table, []);
      outRefs.get(r.child.table).push(r);
      if (!r.self) {
        if (!inRefs.has(r.parent.table)) inRefs.set(r.parent.table, []);
        inRefs.get(r.parent.table).push(r);
      }
    }

    // ---- 조인테이블(N:M) 판별 ----
    const norm = (s) => s.toLowerCase().replace(/ies$/, 'y').replace(/s$/, '');
    const junctions = Object.create(null); // table → [endA, endB] | null(다대상 링크)
    for (const t of model.tables) {
      const fks = (outRefs.get(t.name) || []).filter((r) => !r.self);
      if (fks.length < 2) continue;
      const fkColSet = new Set(fks.flatMap((r) => r.child.cols));
      const pkSet = new Set(t.pkCols);
      const pkFkRefs = fks.filter((r) => pkSet.has(r.child.cols[0]));
      // 강한 신호: 복합 PK의 FK 컬럼이 2개 이상
      if (t.pkCols.length >= 2 && pkFkRefs.length >= 2) {
        junctions[t.name] = [pkFkRefs[0].parent.table, pkFkRefs[1].parent.table];
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
          junctions[t.name] = [fks[0].parent.table, fks[1].parent.table];
          continue;
        }
      }
      // 약한 신호: FK 3개 이상 + payload 1개 이하 → 다대상 링크 테이블
      if (fks.length >= 3 && payload.length <= 1) junctions[t.name] = null;
    }

    const ctx = {
      isJunction: (t) => t in junctions,
      junctionPrimary: (t, parent) => {
        const j = junctions[t];
        return !!j && j[0] === parent;
      },
      colInPk: (t, col) => {
        const tb = byName.get(t);
        return !!tb && tb.pkCols.length > 0 && tb.pkCols.includes(col) && tb.pkCols.length > 1;
      },
      colNotNull: (t, col) => {
        const tb = byName.get(t);
        const c = tb && tb.cols.find((x) => x.name === col);
        return !!c && c.notNull;
      },
      sameGroup: (a, b) => {
        const ta = byName.get(a), tb = byName.get(b);
        return !!ta && !!tb && !!ta.group && ta.group === tb.group;
      },
    };

    // ---- ref별 메타 ----
    const refMeta = Object.create(null);
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
      };
    }

    // ---- 허브 판별 ----
    const PERSON = new Set(['own', 'req', 'auth', 'share', 'ment']);
    const hubs = [];
    for (const t of model.tables) {
      const inc = inRefs.get(t.name) || [];
      if (inc.length < 8) continue;
      const personCount = inc.filter((r) => PERSON.has(refMeta[r.id].type)).length;
      if (personCount / inc.length >= 0.6) hubs.push({ table: t.name, inDegree: inc.length });
    }
    // tenant류 명시 허브(엣지가 있다면)
    for (const t of model.tables) {
      const inc = inRefs.get(t.name) || [];
      if (/^tenants?$/.test(t.name) && inc.length >= 5 && !hubs.some((h) => h.table === t.name))
        hubs.push({ table: t.name, inDegree: inc.length });
    }

    const tableMeta = Object.create(null);
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

  return { analyze, TYPES };
});
