// 컬럼 하나에 대해 "카드에 들어가지 못한 사실"을 모은다.
//
// 전체 ERD의 테이블 카드는 폭 232px 고정이라 타입·NULL 여부·기본값·설명·enum 값·복합
// UNIQUE가 화면에 올라오지 못한다. 호버 툴팁이 그 자리를 메우는데, 무엇을 보여줄지 정하는
// 판단은 DOM과 무관한 순수 계산이다. semantics.ts와 같은 이유로 src/에 둔다 —
// 렌더(renderer/erd.ts)와 노드 테스트(scripts/check-model.ts)가 같은 함수를 본다.

import type { Column, Enum, Model, Ref } from './model.ts';

/** 컬럼이 FK에 참여하는 방식. lead = 이 컬럼이 ref의 선두 — 카드에 `→ 부모`로 표시되는 쪽 */
export type FkRole = 'lead' | 'member';

export type ColumnFk = { ref: Ref; role: FkRole };

export type ColumnFacts = {
  table: string;
  column: Column;
  /** 이 컬럼이 속한 복합 UNIQUE 인덱스들. 단일 컬럼 UNIQUE는 Column.unique가 갖는다 */
  compositeUnique: string[][];
  /** Column.type과 이름이 정확히 같은 enum. 없으면 null */
  enumDef: Enum | null;
  /** 이 컬럼이 참여하는 FK 하나. 선두 ref를 우선한다. 없으면 null */
  fk: ColumnFk | null;
};

/** 테이블이나 컬럼이 모델에 없으면 null */
export function columnFacts(model: Model, table: string, column: string): ColumnFacts | null {
  const t = model.tables.find((x) => x.name === table);
  if (!t) return null;
  const c = t.cols.find((x) => x.name === column);
  if (!c) return null;

  // 카드의 `→ 부모` 표시와 같은 규칙: 선두 ref를 먼저 찾고, 없을 때만 복합 FK 멤버를 본다
  const lead = model.refs.find((r) => r.child.table === table && r.child.cols[0] === column);
  const member = lead
    ? undefined
    : model.refs.find((r) => r.child.table === table && r.child.cols.includes(column));
  const fk: ColumnFk | null =
    lead ? { ref: lead, role: 'lead' } : member ? { ref: member, role: 'member' } : null;

  return {
    table,
    column: c,
    compositeUnique: t.uniqueIndexes.filter((ix) => ix.includes(column)),
    enumDef: model.enums.find((e) => e.name === c.type) ?? null,
    fk,
  };
}
