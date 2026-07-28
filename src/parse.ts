// DBML 텍스트 → 순수 JSON 모델
//
// @dbml/core는 라인 주석을 버리기 때문에, "// logical" 컨벤션(DB 제약 없는 논리 FK 표기)은
// 파싱 전에 원문 텍스트를 한 번 훑어서 별도로 수집한 뒤 파싱 결과에 병합한다.
//
// 컨벤션: Ref를 선언한 라인(짧은 형식 `Ref: a.x > b.y`, Ref 블록 내부, 인라인 `[ref: > b.y]`)의
// **트레일링 `//` 주석**에 단어 `logical`이 있으면 그 Ref를 논리 FK로 취급한다. 표기가 없으면 실 FK.
// 주석 처리된 라인·블록 주석·note 문자열 속 텍스트는 수집하지 않는다.

import fs from 'node:fs';
import path from 'node:path';
import { Parser } from '@dbml/core';

import type { Endpoint, Model } from './model.ts';
// @dbml/core가 돌려주는 구조 중 우리가 실제로 읽는 부분만 적는다.
// 라이브러리가 내보내는 타입과 어긋나는 자리(예: Ref.note)가 있어, 경계에서 한 번만 좁혀 쓰고
// 그 안쪽은 src/model.ts의 타입으로만 이야기한다.
type RawField = {
  name: string;
  type?: { type_name?: string; args?: string } | null;
  pk?: boolean; unique?: boolean; not_null?: boolean;
  note?: unknown;
  dbdefault?: { value?: unknown } | null;
};
type RawIndex = { columns?: { value?: string }[]; pk?: boolean; unique?: boolean };
type RawTable = { name: string; note?: unknown; fields?: RawField[]; indexes?: RawIndex[] };
type RawEndpoint = { schemaName?: string | null; tableName: string; fieldNames?: string[]; relation?: string };
type RawRef = { endpoints?: RawEndpoint[]; onDelete?: string | null; onUpdate?: string | null; note?: unknown };
type RawGroupMember = { schemaName?: string | null; tableName?: string; name?: string };
type RawGroup = { name: string; tables?: RawGroupMember[] };
type RawEnum = { name: string; values?: { name: string; note?: unknown }[] };
type RawSchema = { name: string; tables?: RawTable[]; refs?: RawRef[]; tableGroups?: RawGroup[]; enums?: RawEnum[] };
type RawDatabase = { name?: string | null; note?: unknown; databaseType?: string | null; schemas?: RawSchema[] };



const NAME = '(?:"[^"]+"|\\w+)';
const ENDPOINT = `((?:${NAME}\\.)+(?:\\([^)]+\\)|${NAME}))`;
const REF_RE = new RegExp(`${ENDPOINT}\\s*(<>|[<>-])\\s*${ENDPOINT}`);
const INLINE_RE = new RegExp(`\\bref\\s*:\\s*(<>|[<>-])\\s*${ENDPOINT}`, 'i');
const TABLE_RE = new RegExp(`^\\s*Table\\s+(${NAME}(?:\\.${NAME})?)(?:\\s+as\\s+(${NAME}))?`, 'i');

// note 계열은 라이브러리에서 형태가 정해지지 않은 값으로 온다 — 문자열이 아니면 null로 눕힌다
const noteOf = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const unq = (s: string): string => s.replace(/^"|"$/g, '');

// 라인을 (코드, 트레일링 주석)으로 분리 — 따옴표 문자열 안의 //는 무시
function splitComment(line: string): [string, string] {
  let inS = false, inD = false;
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (ch === '/' && line[i + 1] === '/' && !inS && !inD)
      return [line.slice(0, i), line.slice(i + 2)];
  }
  return [line, ''];
}

// 블록 주석·트리플쿼트 노트를 (라인수 유지하며) 공백화.
// 상태 추적 스캐너 — 라인 주석 안의 "/*"(예: 경로 글롭 deploy/*.sql)나
// 문자열 안의 마커가 블록 시작으로 오인되지 않게 한다.
function stripBlocks(text: string): string {
  const out = text.split('');
  const blank = (start: number, len: number): void => {
    for (let k = 0; k < len; k++) if (out[start + k] !== '\n') out[start + k] = ' ';
  };
  let i = 0, state = null; // null | 'line' | 'block' | 'squote' | 'dquote' | 'triple'
  const n = text.length;
  while (i < n) {
    const c = text[i], c2 = text.substr(i, 2), c3 = text.substr(i, 3);
    if (state === null) {
      if (c3 === "'''") { state = 'triple'; blank(i, 3); i += 3; }
      else if (c === "'") { state = 'squote'; i++; }
      else if (c === '"') { state = 'dquote'; i++; }
      else if (c2 === '//') { state = 'line'; i += 2; }
      else if (c2 === '/*') { state = 'block'; blank(i, 2); i += 2; }
      else i++;
    } else if (state === 'line') {
      if (c === '\n') state = null;
      i++;
    } else if (state === 'block') {
      if (c2 === '*/') { blank(i, 2); state = null; i += 2; }
      else { if (c !== '\n') out[i] = ' '; i++; }
    } else if (state === 'squote') {
      if (c === '\\') i += 2;
      else { if (c === "'" || c === '\n') state = null; i++; }
    } else if (state === 'dquote') {
      if (c === '\\') i += 2;
      else { if (c === '"' || c === '\n') state = null; i++; }
    } else { // triple
      if (c3 === "'''") { blank(i, 3); state = null; i += 3; }
      else { if (c !== '\n') out[i] = ' '; i++; }
    }
  }
  return out.join('');
}

// "table.col" 또는 "table.(c1, c2)" → {table, cols[]}  (public. 접두 제거, 따옴표 해제, 별칭 해소)
function parseEndpoint(raw: string, aliasMap: Record<string, string>): Endpoint {
  let table: string, cols: string[];
  const pm = raw.match(/^(.*?)\.\(([^)]+)\)$/);
  if (pm) {
    table = pm[1] ?? '';
    cols = (pm[2] ?? '').split(',').map((s) => unq(s.trim()));
  } else {
    const parts: string[] = [];
    const re = new RegExp(`${NAME}`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) parts.push(unq(m[0]));
    cols = [parts.pop() ?? ''];
    table = parts.join('.');
  }
  table = unq(table).replace(/^public\./, '');
  const aliased = aliasMap[table];
  if (aliased) table = aliased;
  return { table, cols };
}

const epKey = (ep: Endpoint): string => `${ep.table}.${ep.cols.join('+')}`;
const pairKey = (a: Endpoint, b: Endpoint): string => [epKey(a), epKey(b)].sort().join('|');

// 원문에서 logical 표기된 ref의 (양끝 endpoint) 쌍 수집
function collectLogicalKeys(text: string): Set<string> {
  const keys = new Set<string>();
  const lines = stripBlocks(text).split(/\r?\n/);

  // 1차: 테이블 별칭 수집
  const aliasMap: Record<string, string> = {};
  for (const line of lines) {
    const [code] = splitComment(line);
    const tm = code.match(TABLE_RE);
    if (tm && tm[2]) aliasMap[unq(tm[2])] = unq(tm[1] ?? '').replace(/^public\./, '');
  }

  // 2차: 본 스캔
  let curTable: string | null = null, depth = 0;
  for (const line of lines) {
    const [code, comment] = splitComment(line);
    const tm = code.match(TABLE_RE);
    if (tm) curTable = unq(tm[1] ?? '').replace(/^public\./, '');
    const marked = /\blogical\b/i.test(comment);

    if (marked) {
      // note 문자열(작은따옴표) 안의 ref 모양 텍스트는 제외하고 매치
      const codeNoStr = code.replace(/'[^']*'/g, "''");
      const rm = codeNoStr.match(REF_RE);
      if (rm) {
        keys.add(pairKey(parseEndpoint(rm[1] ?? '', aliasMap), parseEndpoint(rm[3] ?? '', aliasMap)));
      } else {
        const im = codeNoStr.match(INLINE_RE);
        if (im && curTable && depth > 0) {
          const colM = code.match(new RegExp(`^\\s*(${NAME})`));
          if (colM) {
            keys.add(pairKey(
              { table: curTable, cols: [unq(colM[1] ?? '')] },
              parseEndpoint(im[2] ?? '', aliasMap)
            ));
          }
        }
      }
    }
    depth += (code.match(/\{/g) || []).length - (code.match(/\}/g) || []).length;
    if (depth <= 0) { depth = 0; if (!tm) curTable = null; }
  }
  return keys;
}

function fieldType(f: RawField): string {
  if (!f.type) return '';
  let t = f.type.type_name || '';
  if (f.type.args && !/\(/.test(t)) t += `(${f.type.args})`;
  return t;
}

// @dbml/core 파싱 에러(diags)를 읽을 수 있는 메시지로 변환
function fmtParseError(e: unknown): Error {
  const any = e as { diags?: unknown; error?: { diags?: unknown }; message?: string } | null;
  const diags = any && (any.diags || (any.error && any.error.diags));
  if (Array.isArray(diags) && diags.length) {
    const msg = diags.slice(0, 5).map((d: { location?: { start?: { line: number; column: number } }; message?: string }) => {
      const st = d.location && d.location.start;
      return (st ? `${st.line}:${st.column} ` : '') + (d.message || String(d));
    }).join('\n');
    return new Error(msg + (diags.length > 5 ? `\n… 외 ${diags.length - 5}건` : ''));
  }
  if (e instanceof Error && e.message) return e;
  return new Error(String((any && any.message) || e));
}

function parseDbml(text: string, sourcePath?: string | null): Model {
  const logicalKeys = collectLogicalKeys(text);

  let database: RawDatabase;
  try {
    database = new Parser().parse(text, 'dbmlv2') as unknown as RawDatabase;
  } catch (e1) {
    try {
      database = new Parser().parse(text, 'dbml') as unknown as RawDatabase; // 구 파서 폴백
    } catch (e2) {
      throw fmtParseError(e1);
    }
  }

  const model: Model = {
    meta: {
      sourcePath: sourcePath || null,
      projectName: database.name || null,
      projectNote: noteOf(database.note),
      databaseType: database.databaseType || null,
    },
    tables: [],
    refs: [],
    groups: [],
    enums: [],
  };

  const schemas = database.schemas || [];
  const multiSchema = schemas.length > 1;
  const tname = (schemaName: string | null | undefined, tableName: string): string =>
    multiSchema && schemaName && schemaName !== 'public'
      ? `${schemaName}.${tableName}`
      : tableName;
  // logical 키 매칭용 이름(표시명과 달리 항상 public 제거 + 스키마 유지)
  const kname = (schemaName: string | null | undefined, tableName: string): string =>
    schemaName && schemaName !== 'public' ? `${schemaName}.${tableName}` : tableName;

  for (const schema of schemas) {
    for (const en of schema.enums || []) {
      model.enums.push({
        name: en.name,
        values: (en.values || []).map((v) => ({ name: v.name, note: noteOf(v.note) })),
      });
    }

    for (const t of schema.tables || []) {
      const cols = (t.fields || []).map((f) => ({
        name: f.name,
        type: fieldType(f),
        pk: !!f.pk,
        unique: !!f.unique,
        notNull: !!f.not_null || !!f.pk,
        note: noteOf(f.note),
        dflt: f.dbdefault != null ? String(f.dbdefault.value) : null,
      }));
      // 복합 PK/UNIQUE 인덱스 반영
      const pkCols = cols.filter((c) => c.pk).map((c) => c.name);
      const uniqueIndexes: string[][] = [];
      for (const idx of t.indexes || []) {
        const idxCols = (idx.columns || []).map((c) => c.value ?? '');
        if (idx.pk) {
          for (const cn of idxCols) {
            const col = cols.find((c) => c.name === cn);
            if (col) { col.pk = true; col.notNull = true; }
            if (!pkCols.includes(cn)) pkCols.push(cn);
          }
        } else if (idx.unique) {
          if (idxCols.length === 1) {
            const col = cols.find((c) => c.name === idxCols[0]);
            if (col) col.unique = true;
          } else uniqueIndexes.push(idxCols);
        }
      }
      model.tables.push({
        name: tname(schema.name, t.name),
        note: noteOf(t.note),
        group: null, // 아래 TableGroup에서 채움
        cols,
        pkCols,
        uniqueIndexes,
      });
    }

    for (const g of schema.tableGroups || []) {
      model.groups.push({
        name: g.name,
        tables: (g.tables || []).map((x) => tname(x.schemaName || schema.name, x.tableName || x.name || '')),
      });
    }

    for (const r of schema.refs || []) {
      const eps = r.endpoints || [];
      if (eps.length !== 2) continue;
      const ep = (e: RawEndpoint) => ({
        table: tname(e.schemaName || schema.name, e.tableName),
        keyTable: kname(e.schemaName || schema.name, e.tableName),
        cols: (e.fieldNames || []).map(unq),
        relation: e.relation, // '1' | '*'
      });
      const [e0, e1] = eps;
      if (!e0 || !e1) continue;
      const a = ep(e0), b = ep(e1);
      let child = a, parent = b;
      let oneToOne = false, manyToMany = false;
      if (a.relation === '*' && b.relation === '1') { child = a; parent = b; }
      else if (a.relation === '1' && b.relation === '*') { child = b; parent = a; }
      else if (a.relation === '1' && b.relation === '1') { oneToOne = true; }
      else if (a.relation === '*' && b.relation === '*') { manyToMany = true; }

      const key = pairKey(
        { table: child.keyTable, cols: child.cols },
        { table: parent.keyTable, cols: parent.cols }
      );
      model.refs.push({
        id: `${child.table}.${child.cols.join('+')}->${parent.table}.${parent.cols.join('+')}`,
        child: { table: child.table, cols: child.cols },
        parent: { table: parent.table, cols: parent.cols },
        kind: logicalKeys.has(key) ? 'logical' : 'real',
        oneToOne,
        manyToMany,
        self: child.table === parent.table,
        onDelete: r.onDelete || null,
        onUpdate: r.onUpdate || null,
        note: noteOf(r.note),
      });
    }
  }

  // TableGroup → 테이블에 그룹명 반영 (첫 매칭 우선)
  const byName = new Map(model.tables.map((t) => [t.name, t]));
  for (const g of model.groups) {
    for (const tn of g.tables) {
      const t = byName.get(tn);
      if (t && !t.group) t.group = g.name;
    }
  }
  return model;
}

function parseDbmlFile(filePath: string): Model {
  const text = fs.readFileSync(filePath, 'utf8');
  return parseDbml(text, path.resolve(filePath));
}

export { parseDbml, parseDbmlFile };
