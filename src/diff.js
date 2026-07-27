// 두 리비전의 파싱 모델을 맞대어 테이블·컬럼·관계의 추가/삭제/변경을 낸다.
// 순수 함수, 의존성 없음 — Node(검증 스크립트)와 브라우저(renderer) 양쪽에서 로드된다.
//
// 짝짓기 기준:
//  - 테이블: 이름
//  - 컬럼: (테이블, 컬럼명)
//  - 관계: parse가 만든 안정 id `자식.컬럼->부모.컬럼`.
//    FK 컬럼이 바뀌면 id가 달라지므로 "삭제 + 추가"로 나온다. 이름 없는 관계를 이름 비슷한
//    것끼리 억지로 이어붙이는 것보다, 끊기고 새로 생겼다고 말하는 편이 정직하다.
//
// 경계: 테이블 상태는 그 테이블 "자신의 정의"(컬럼·PK·유니크·그룹·설명)만 반영한다.
// 관계 변경은 관계선이 표현하므로 양 끝 테이블을 물들이지 않는다 — 안 그러면 관계 하나가
// 바뀔 때 다이어그램 절반이 변경으로 칠해져 정작 무엇이 바뀌었는지 안 보인다.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SchemaDiff = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const COL_FIELDS = ['type', 'pk', 'unique', 'notNull', 'dflt', 'note'];
  // 삭제/갱신 동작은 표기 변형(대소문자·공백)을 흡수해 비교한다 — 의미가 같으면 변경이 아니다.
  const REF_FIELDS = ['kind', 'oneToOne', 'manyToMany', 'note'];
  const REF_ACTION_FIELDS = ['onDelete', 'onUpdate'];

  const byName = (list) => new Map((list || []).map((x) => [x.name, x]));
  const nil = (v) => (v == null ? null : v);
  const normAction = (v) => (v == null ? null : String(v).trim().toLowerCase().replace(/[\s_]+/g, ' '));
  const listKey = (l) => (l || []).join(' ');
  const idxKey = (t) => (t.uniqueIndexes || []).map(listKey).sort().join('');

  function fieldDiff(b, a, fields, norm) {
    const out = [];
    const f2 = norm || nil;
    for (const f of fields) if (f2(b[f]) !== f2(a[f])) out.push(f);
    return out;
  }

  // 통째로 생기거나 사라진 테이블은 컬럼도 전부 같은 상태로 채운다 — 렌더가 카드 안까지 한 색으로 칠할 수 있게
  function allCols(t, status) {
    const cols = {};
    for (const c of t.cols || []) cols[c.name] = status === 'added' ? { status, after: c } : { status, before: c };
    return cols;
  }

  function diffCols(b, a) {
    const B = byName(b.cols), A = byName(a.cols);
    const cols = {};
    let changed = false;
    for (const [name, bc] of B) {
      const ac = A.get(name);
      if (!ac) { cols[name] = { status: 'removed', before: bc }; changed = true; continue; }
      const reasons = fieldDiff(bc, ac, COL_FIELDS);
      if (reasons.length) { cols[name] = { status: 'changed', reasons, before: bc, after: ac }; changed = true; }
      else cols[name] = { status: 'same', before: bc, after: ac };
    }
    for (const [name, ac] of A) {
      if (B.has(name)) continue;
      cols[name] = { status: 'added', after: ac };
      changed = true;
    }
    return { cols, changed };
  }

  function diffModels(before, after) {
    const tables = {}, refs = {};
    const summary = {
      tables: { added: 0, removed: 0, changed: 0 },
      refs: { added: 0, removed: 0, changed: 0 },
    };

    const BT = byName(before.tables), AT = byName(after.tables);
    for (const [name, b] of BT) {
      const a = AT.get(name);
      if (!a) {
        tables[name] = { status: 'removed', reasons: [], cols: allCols(b, 'removed'), before: b };
        summary.tables.removed++;
        continue;
      }
      const { cols, changed } = diffCols(b, a);
      const reasons = [];
      if (changed) reasons.push('cols');
      if (nil(b.group) !== nil(a.group)) reasons.push('group');
      if (listKey(b.pkCols) !== listKey(a.pkCols)) reasons.push('pkCols');
      if (idxKey(b) !== idxKey(a)) reasons.push('uniqueIndexes');
      if (nil(b.note) !== nil(a.note)) reasons.push('note');
      const status = reasons.length ? 'changed' : 'same';
      if (status === 'changed') summary.tables.changed++;
      tables[name] = { status, reasons, cols, before: b, after: a };
    }
    for (const [name, a] of AT) {
      if (BT.has(name)) continue;
      tables[name] = { status: 'added', reasons: [], cols: allCols(a, 'added'), after: a };
      summary.tables.added++;
    }

    const BR = new Map((before.refs || []).map((r) => [r.id, r]));
    const AR = new Map((after.refs || []).map((r) => [r.id, r]));
    for (const [id, b] of BR) {
      const a = AR.get(id);
      if (!a) { refs[id] = { status: 'removed', reasons: [], before: b }; summary.refs.removed++; continue; }
      const reasons = fieldDiff(b, a, REF_FIELDS)
        .concat(fieldDiff(b, a, REF_ACTION_FIELDS, normAction));
      const status = reasons.length ? 'changed' : 'same';
      if (status === 'changed') summary.refs.changed++;
      refs[id] = { status, reasons, before: b, after: a };
    }
    for (const [id, a] of AR) {
      if (BR.has(id)) continue;
      refs[id] = { status: 'added', reasons: [], after: a };
      summary.refs.added++;
    }

    return { tables, refs, summary };
  }

  // 카드에 보여줄 컬럼 이름을 원본 순서로 고른다.
  //
  // 불변식: 바뀐 컬럼은 어떤 경우에도 접히지 않는다. 변경을 색으로 알리는 화면에서 정작 바뀐
  // 줄이 숨으면 테두리만 물든 채 이유를 알 수 없다. 자리가 모자라면 키 컬럼부터 접고, 변경이
  // 정원보다 많으면 정원을 넘겨서라도 다 보여준다(그만큼 실제로 크게 바뀐 테이블이다).
  function visibleCols(cols, tableDiff, opts) {
    const o = opts || {};
    const max = o.max == null ? 12 : o.max;
    const fk = o.fkNames || new Set();
    const list = cols || [];
    if (o.colsMode === 'all') return list.map((c) => c.name);
    const st = (n) => ((tableDiff && tableDiff.cols && tableDiff.cols[n]) || {}).status || 'same';
    const changed = list.filter((c) => st(c.name) !== 'same').map((c) => c.name);
    const keys = list.filter((c) => st(c.name) === 'same' && (c.pk || c.unique || fk.has(c.name)))
      .map((c) => c.name);
    const keep = new Set([...changed, ...keys.slice(0, Math.max(0, max - changed.length))]);
    if (!keep.size) for (const c of list.slice(0, 3)) keep.add(c.name);
    return list.filter((c) => keep.has(c.name)).map((c) => c.name);
  }

  return { diffModels, visibleCols };
});
