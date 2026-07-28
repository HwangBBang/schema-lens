// 파싱된 DBML 모델의 형태. 파서·의미 레이어·비교·렌더가 모두 이 타입을 기준으로 이야기한다.
//
// 이 파일에는 값이 없다(타입 선언만). 파서가 실제로 만들어내는 모양을 그대로 옮긴 것이므로,
// parse.ts가 채우는 필드가 바뀌면 여기부터 고쳐야 나머지가 따라온다.

export type Column = {
  name: string;
  type: string;
  pk: boolean;
  unique: boolean;
  notNull: boolean;
  note: string | null;
  dflt: string | null;
};

export type Table = {
  name: string;
  note: string | null;
  /** TableGroup 소속. 어느 그룹에도 안 들어가면 null */
  group: string | null;
  cols: Column[];
  pkCols: string[];
  /** 복합 UNIQUE 인덱스만. 단일 컬럼 UNIQUE는 Column.unique로 들어간다 */
  uniqueIndexes: string[][];
};

export type Endpoint = {
  table: string;
  cols: string[];
};

/** 실 FK인지, `// logical` 주석으로 표기한 논리 관계인지 */
export type RefKind = 'real' | 'logical';

export type Ref = {
  /** `자식.컬럼->부모.컬럼` — 파서가 만드는 안정 식별자. 비교에서 짝짓기 기준이 된다 */
  id: string;
  child: Endpoint;
  parent: Endpoint;
  kind: RefKind;
  oneToOne: boolean;
  manyToMany: boolean;
  self: boolean;
  onDelete: string | null;
  onUpdate: string | null;
  note: string | null;
};

export type Group = {
  name: string;
  tables: string[];
};

export type EnumValue = {
  name: string;
  note: string | null;
};

export type Enum = {
  name: string;
  values: EnumValue[];
};

export type ModelMeta = {
  sourcePath: string | null;
  projectName: string | null;
  projectNote: string | null;
  databaseType: string | null;
};

export type Model = {
  meta: ModelMeta;
  tables: Table[];
  refs: Ref[];
  groups: Group[];
  enums: Enum[];
};
