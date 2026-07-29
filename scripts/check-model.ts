// assets/example.dbml을 파싱해 설계 시점에 확정한 기대값(ground truth)과 대조하고,
// "// logical" 프리패스·조인 휴리스틱의 엣지케이스를 인라인 픽스처로 회귀 테스트한다.
// 실행: npm test
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { importer } from '@dbml/core';
import { parseDbml, parseDbmlFile } from '../src/parse.ts';
import * as Semantics from '../src/semantics.ts';
import { diffModels, visibleCols } from '../src/diff.ts';
import { gitBaseline, isFailure } from '../src/git-baseline.ts';
import type { Column } from '../src/model.ts';
import type { ImpactEntry } from '../src/semantics.ts';
import type { TableDiff } from '../src/diff.ts';
import { columnFacts } from '../src/column-facts.ts';

// 빌드 산출물(out/scripts/)에서 실행되므로 저장소 루트를 거슬러 올라가 잡는다
const ROOT = path.resolve(__dirname, '..', '..');

const model = parseDbmlFile(path.join(ROOT, 'assets', 'example.dbml'));
const sem = Semantics.analyze(model);

let pass = 0, fail = 0;
function check(name: string, cond: unknown, detail?: string | number): void {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function refOf(childTable: string, childCol: string) {
  return model.refs.find((r) => r.child.table === childTable && r.child.cols[0] === childCol);
}

// ---- 파싱 ----
check('테이블 29개', model.tables.length === 29, `got ${model.tables.length}`);
check('그룹 8개', model.groups.length === 8, `got ${model.groups.length}`);
const real = model.refs.filter((r) => r.kind === 'real');
const logical = model.refs.filter((r) => r.kind === 'logical');
check('실 FK 39개', real.length === 39, `got ${real.length}`);
check('논리 FK 8개', logical.length === 8, `got ${logical.length}`);
check('workspace Ref는 주석 블록이라 미포함', !model.refs.some((r) => r.parent.table === 'workspaces'));

const insightsRef = refOf('repo_insights', 'repo_id');
check('repo_insights↔repos 1:1(-) 파싱', !!insightsRef && insightsRef.oneToOne);
check('repo_insights ref는 logical', !!insightsRef && insightsRef.kind === 'logical');

const selfRefs = model.refs.filter((r) => r.self);
check('self-ref 2개(teams, comments)', selfRefs.length === 2,
  selfRefs.map((r) => r.child.table).join(','));

const us = model.tables.find((t) => t.name === 'user_settings');
check('복합 PK 인식(user_settings)', !!us && us.pkCols.length === 2, us && us.pkCols.join(','));

const users = model.tables.find((t) => t.name === 'users');
check('users.email unique', !!users && users.cols.find((c) => c.name === 'email')?.unique);
check('컬럼 note 보존', !!users && /workspaces\.id/.test(users.cols.find((c) => c.name === 'workspace_id')?.note || ''));

// ---- 의미 레이어: 관계 유형 ----
const typeExpect = {
  'repos.owner_id': 'own',
  'issues.assignee_id': 'own',
  'api_tokens.account_id': 'own',
  'saved_filters.user_id': 'own',
  'notifications.user_id': 'own',
  'review_requests.requested_by': 'req',
  'issues.milestone_id': 'ref',
  'teams.parent_id': 'hier',
  'comments.parent_id': 'hier',
  'issues.repo_id': 'comp',
  'issue_attachments.issue_id': 'comp',
  'merge_request_commits.merge_request_id': 'comp',
  'repo_insights.repo_id': 'comp',
  'issues.author_id': 'auth',
  'issue_attachments.uploaded_by': 'auth',
  'audit_events.actor_id': 'auth',
  'wiki_revisions.created_by': 'auth',
  'comment_mentions.mentioned_user_id': 'ment',
  'issue_watchers.user_id': 'share',
  'comment_reads.user_id': 'share',
};
for (const [key, want] of Object.entries(typeExpect)) {
  const [t, c] = key.split('.');
  const r = refOf(t ?? '', c ?? '');
  const got = r && sem.refMeta[r.id]?.type;
  check(`유형 ${key} = ${want}`, got === want, `got ${got}`);
}

// ---- 조인테이블 ----
const junctionExpect = [
  'team_members', 'repo_collaborators', 'repo_stars', 'issue_labels', 'issue_watchers',
  'comment_mentions', 'comment_reactions', 'comment_reads', 'review_requests',
];
for (const j of junctionExpect) check(`조인테이블 ${j}`, j in sem.junctions, 'not detected');
check('조인 오탐 없음(issues)', !('issues' in sem.junctions));
check('조인 오탐 없음(comments)', !('comments' in sem.junctions));
check('조인 오탐 없음(merge_requests)', !('merge_requests' in sem.junctions));
check('조인 오탐 없음(wiki_revisions)', !('wiki_revisions' in sem.junctions));
check('조인 오탐 없음(issue_attachments)', !('issue_attachments' in sem.junctions));
check('wiki_page_links는 다대상 링크', 'wiki_page_links' in sem.junctions &&
  sem.tableMeta['wiki_page_links']?.junction === 'multi');

// ---- 카디널리티 ----
check('repo_insights 1:1', insightsRef && sem.refMeta[insightsRef.id]?.card === '1:1');
const assigneeRef = refOf('issues', 'assignee_id');
check('issues.assignee_id N:1', assigneeRef && sem.refMeta[assigneeRef.id]?.card === 'N:1');

// ---- 허브 ----
check('users 허브 감지(유입 21)', sem.hubs.some((h) => h.table === 'users' && h.inDegree === 21),
  JSON.stringify(sem.hubs));
check('repos는 허브 아님(유입 8이지만 사람비율 미달)', !sem.hubs.some((h) => h.table === 'repos'));
check('issues는 허브 아님', !sem.hubs.some((h) => h.table === 'issues'));

// ---- 라벨(컬럼 note에서 추출) ----
check('라벨 issues.assignee_id=담당자', assigneeRef && sem.refMeta[assigneeRef.id]?.label === '담당자',
  assigneeRef && sem.refMeta[assigneeRef.id]?.label);

// ---- 프리패스 엣지케이스 (인라인 픽스처) ----
function kindOf(dbml: string, childTable: string, childCol: string) {
  const m = parseDbml(dbml);
  const r = m.refs.find((x) => x.child.table === childTable && x.child.cols[0] === childCol);
  return r && r.kind;
}

check('인라인 ref + // logical',
  kindOf(`Table users { id int [pk] }
Table posts { id int [pk]
  user_id int [ref: > users.id] // logical
}`, 'posts', 'user_id') === 'logical');

check('인라인 ref 주석 없음 → real',
  kindOf(`Table users { id int [pk] }
Table posts { id int [pk]
  user_id int [ref: > users.id]
}`, 'posts', 'user_id') === 'real');

check('복합 FK table.(a,b) + // logical',
  kindOf(`Table m { id int [pk]\n cc int }
Table mp { mid int\n cc int }
Ref: mp.(mid, cc) > m.(id, cc) // logical`, 'mp', 'mid') === 'logical');

check('복합/단순 ref 공존 시 서로 전염 없음', (() => {
  const dbml = `Table m { id int [pk]\n cc int }
Table mp { mid int\n cc int }
Ref: mp.mid > m.id // logical
Ref: mp.(mid, cc) > m.(id, cc)`;
  const mo = parseDbml(dbml);
  const simple = mo.refs.find((r) => r.child.cols.length === 1);
  const comp = mo.refs.find((r) => r.child.cols.length === 2);
  return simple?.kind === 'logical' && comp?.kind === 'real';
})());

check('주석 처리된 Ref 라인은 수집 안 함',
  kindOf(`Table users { id int [pk] }
Table posts { id int [pk]\n user_id int }
Ref: posts.user_id > users.id
// Ref: posts.user_id > users.id // logical`, 'posts', 'user_id') === 'real');

check('블록 주석 안의 Ref는 수집 안 함',
  kindOf(`Table users { id int [pk] }
Table posts { id int [pk]\n user_id int }
Ref: posts.user_id > users.id
/* Ref: posts.user_id > users.id // logical */`, 'posts', 'user_id') === 'real');

check('note 문자열 속 ref 모양 텍스트는 수집 안 함',
  kindOf(`Table users { id int [pk] }
Table posts { id int [pk]
  user_id int [note: 'logical link kept in sync with posts.user_id > users.id']
}
Ref: posts.user_id > users.id`, 'posts', 'user_id') === 'real');

check("식별자에 'logical' 포함돼도 주석 없으면 real",
  kindOf(`Table logical_models { id int [pk] }
Table entries { id int [pk]\n model_id int }
Ref: entries.model_id > logical_models.id`, 'entries', 'model_id') === 'real');

check('명시적 public. 접두 + // logical',
  kindOf(`Table users { id int [pk] }
Table posts { id int [pk]\n user_id int }
Ref: public.posts.user_id > public.users.id // logical`, 'posts', 'user_id') === 'logical');

check('공백 포함 따옴표 이름 + // logical',
  kindOf(`Table "order items" { id int [pk]\n order_id int }
Table orders { id int [pk] }
Ref: "order items".order_id > orders.id // logical`, 'order items', 'order_id') === 'logical');

check('별칭(as)으로 선언된 Ref + // logical',
  kindOf(`Table users as U { id int [pk] }
Table posts { id int [pk]\n user_id int }
Ref: posts.user_id > U.id // logical`, 'posts', 'user_id') === 'logical');

check('파싱 에러 메시지에 위치 정보 포함', (() => {
  try { parseDbml('Table broken { id int'); return false; }
  catch (e) { const m = e instanceof Error ? e.message : ''; return m !== '' && m !== '[object Object]' && m.length > 3; }
})());

// ---- 조인 오탐/프로토타입 키 회귀 ----
check('독립 엔티티(orders)는 N:M 오탐 없음', (() => {
  const mo = parseDbml(`Table customers { id int [pk] }
Table products { id int [pk] }
Table orders { id int [pk]
  customer_id int [ref: > customers.id]
  product_id int [ref: > products.id]
  status varchar
}`);
  const s = Semantics.analyze(mo);
  return !('orders' in s.junctions);
})());

check("'constructor' 테이블명 무해", (() => {
  const mo = parseDbml('Table constructor { id int [pk] }');
  const s = Semantics.analyze(mo);
  return s.tableMeta['constructor'] && s.tableMeta['constructor'].junction === null;
})());

// ---- 삭제 영향: 액션 정규화(actionOf) · ACTIONS 계약 ----
// 단언 안에서 터진 예외는 그 자체가 실패다 — 검사기가 멈추지 않게 여기서 삼킨다
const t = (fn: () => unknown): unknown => { try { return fn(); } catch { return false; } };
const ao = Semantics.actionOf;

check('actionOf export', typeof ao === 'function');
check('ACTIONS 6종 계약(label·cssVar)', t(() =>
  ['cascade', 'set null', 'set default', 'restrict', 'no action', 'unknown']
    .every((k) => Semantics.ACTIONS[k as keyof typeof Semantics.ACTIONS] && Semantics.ACTIONS[k as keyof typeof Semantics.ACTIONS].label && Semantics.ACTIONS[k as keyof typeof Semantics.ACTIONS].cssVar)));
check('actionOf cascade', t(() => { const a = ao('cascade'); return a.action === 'cascade' && a.specified === true; }));
check('actionOf 대소문자·공백 변형 흡수', t(() =>
  ao(' CASCADE ').action === 'cascade' && ao('Set  Null').action === 'set null' &&
  ao('SET DEFAULT').action === 'set default' && ao('Restrict').action === 'restrict'));
check('actionOf 미지정 → no action + specified:false', t(() => {
  const a = ao(null), b = ao(undefined);
  return a.action === 'no action' && a.specified === false && b.specified === false;
}));
check('actionOf 명시 no action → specified:true', t(() => {
  const a = ao('no action');
  return a.action === 'no action' && a.specified === true;
}));
check('actionOf 미지 문자열 → unknown + 원문 보존', t(() => {
  const a = ao('do weird');
  return a.action === 'unknown' && a.raw === 'do weird';
}));

check('refMeta에 onDelete/onUpdate 정규화 포함', t(() => {
  const mo = parseDbml(`Table p { id int [pk] }
Table c { id int [pk]\n p_id int }
Ref: c.p_id > p.id [delete: cascade]`);
  const s = Semantics.analyze(mo);
  const r = mo.refs[0];
  return !!r && s.refMeta[r.id]?.onDelete.action === 'cascade' && s.refMeta[r.id]?.onUpdate.specified === false;
}));

// ---- 삭제 영향(deleteImpact) 인라인 픽스처 ----
const di = (dbml: string, root: string) => Semantics.deleteImpact(parseDbml(dbml), root);
const flatten = (entries: ImpactEntry[] | undefined): ImpactEntry[] => {
  const out = [];
  (function walk(list) { for (const e of list || []) { out.push(e); walk(e.children); } })(entries);
  return out;
};

// A. cascade 2단 전파 + set null 정지(하류 미방문)
const fxA = `Table users { id int [pk] }
Table posts { id int [pk]\n user_id int }
Table post_likes { id int [pk]\n post_id int }
Table drafts { id int [pk]\n user_id int }
Table draft_notes { id int [pk]\n draft_id int }
Ref: posts.user_id > users.id [delete: cascade]
Ref: post_likes.post_id > posts.id [delete: cascade]
Ref: drafts.user_id > users.id [delete: set null]
Ref: draft_notes.draft_id > drafts.id [delete: cascade]`;
check('impact: cascade 2단 전파', t(() => {
  const r = di(fxA, 'users');
  return r.summary.guaranteed.cascade.includes('posts') && r.summary.guaranteed.cascade.includes('post_likes');
}));
check('impact: post_likes는 depth 2', t(() =>
  flatten(di(fxA, 'users').entries).some((e) => e.table === 'post_likes' && e.depth === 2)));
check('impact: set null은 종단(행 생존)', t(() =>
  di(fxA, 'users').summary.guaranteed.setNull.includes('drafts')));
check('impact: set null 하류(draft_notes)는 미방문', t(() =>
  !flatten(di(fxA, 'users').entries).some((e) => e.table === 'draft_notes')));

// B. 거부권 수집 — NOT NULL set null / restrict / 미지정
const fxB = `Table users { id int [pk] }
Table a { id int [pk]\n user_id int [not null] }
Table b { id int [pk]\n user_id int }
Table c { id int [pk]\n user_id int }
Ref: a.user_id > users.id [delete: set null]
Ref: b.user_id > users.id [delete: restrict]
Ref: c.user_id > users.id`;
check('impact: NOT NULL 컬럼의 set null은 거부권', t(() =>
  di(fxB, 'users').vetoed.some((v) => v.table === 'a')));
check('impact: restrict는 거부권', t(() =>
  di(fxB, 'users').vetoed.some((v) => v.table === 'b')));
check('impact: 미지정은 거부권 + specified:false 구분', t(() => {
  const r = di(fxB, 'users');
  const e = flatten(r.entries).find((x) => x.table === 'c');
  return r.vetoed.some((v) => v.table === 'c') && e && e.specified === false;
}));
check('impact: 명시 restrict는 specified:true', t(() => {
  const e = flatten(di(fxB, 'users').entries).find((x) => x.table === 'b');
  return e && e.specified === true;
}));

// C. set default — default 부재 시에만 경고, 거부권 아님
const fxC = `Table users { id int [pk] }
Table d { id int [pk]\n user_id int [default: 0] }
Table e { id int [pk]\n user_id int }
Ref: d.user_id > users.id [delete: set default]
Ref: e.user_id > users.id [delete: set default]`;
check('impact: set default(default 있음)는 경고 없음', t(() => {
  const en = flatten(di(fxC, 'users').entries).find((x) => x.table === 'd');
  return en && !en.warning;
}));
check('impact: set default(default 없음)는 경고, 거부권 아님', t(() => {
  const r = di(fxC, 'users');
  const en = flatten(r.entries).find((x) => x.table === 'e');
  return en && !!en.warning && !r.vetoed.some((v) => v.table === 'e');
}));

// D. 다이아몬드 — set null로 선방문된 테이블이 cascade 경로로 재도달, 하위 restrict 거부권 누락 금지
//    (전역 visited 구현이면 z의 restrict를 놓친다 — path-local stack 회귀 테스트)
const fxD = `Table r { id int [pk] }
Table x { id int [pk]\n r_id int\n y_id int }
Table y { id int [pk]\n r_id int }
Table z { id int [pk]\n x_id int }
Ref: x.r_id > r.id [delete: set null]
Ref: y.r_id > r.id [delete: cascade]
Ref: x.y_id > y.id [delete: cascade]
Ref: z.x_id > x.id [delete: restrict]`;
check('impact: 다이아몬드에서 하위 restrict 거부권 수집', t(() =>
  di(fxD, 'r').vetoed.some((v) => v.table === 'z')));
check('impact: x는 setNull과 cascade 양쪽 집계(ref 단위)', t(() => {
  const s = di(fxD, 'r').summary.guaranteed;
  return s.setNull.includes('x') && s.cascade.includes('x');
}));

// E. 순환 — self-loop와 2노드 순환 모두 종료 + 재귀 표시
check('impact: self-ref cascade 재귀 종료·표시', t(() => {
  const r = di(`Table c { id int [pk]\n parent_id int }
Ref: c.parent_id > c.id [delete: cascade]`, 'c');
  return flatten(r.entries).some((e) => e.table === 'c' && e.cycle) &&
    r.summary.guaranteed.cascade.includes('c');
}));
check('impact: 2노드 순환 종료', t(() => {
  const r = di(`Table a { id int [pk]\n b_id int }
Table b { id int [pk]\n a_id int }
Ref: a.b_id > b.id [delete: cascade]
Ref: b.a_id > a.id [delete: cascade]`, 'a');
  return flatten(r.entries).some((e) => e.cycle);
}));

// F. 논리 관계 — 앱 레벨 격리 분기(guaranteed:false), 거부권 절대 불포함, 무표기는 고아
const fxF = `Table users { id int [pk] }
Table docs { id int [pk]\n user_id int }
Table doc_files { id int [pk]\n doc_id int }
Table notes { id int [pk]\n user_id int }
Table pins { id int [pk]\n user_id int }
Ref: docs.user_id > users.id [delete: cascade] // logical
Ref: doc_files.doc_id > docs.id [delete: cascade]
Ref: notes.user_id > users.id // logical
Ref: pins.user_id > users.id [delete: restrict] // logical`;
check('impact: 논리 cascade는 앱 레벨 분기', t(() => {
  const r = di(fxF, 'users');
  return r.summary.app.cascade.includes('docs') && !r.summary.guaranteed.cascade.includes('docs');
}));
check('impact: 앱 레벨 하류의 실FK도 guaranteed:false 전파', t(() => {
  const e = flatten(di(fxF, 'users').entries).find((x) => x.table === 'doc_files');
  return e && e.guaranteed === false && di(fxF, 'users').summary.app.cascade.includes('doc_files');
}));
check('impact: 논리 restrict는 거부권 불포함', t(() =>
  !di(fxF, 'users').vetoed.some((v) => v.table === 'pins')));
check('impact: 무표기 논리는 고아 가능', t(() =>
  di(fxF, 'users').summary.app.orphan.includes('notes')));

// G. 동일 child 다중 FK — ref 단위 보존 + 카테고리별 dedupe 집계
const fxG = `Table users { id int [pk] }
Table messages { id int [pk]\n sender_id int\n recipient_id int }
Ref: messages.sender_id > users.id [delete: cascade]
Ref: messages.recipient_id > users.id [delete: set null]`;
check('impact: 동일 child 다중 FK는 엔트리 2건(ref 단위)', t(() =>
  flatten(di(fxG, 'users').entries).filter((e) => e.table === 'messages').length === 2));
check('impact: 요약은 카테고리별 테이블 dedupe', t(() => {
  const s = di(fxG, 'users').summary.guaranteed;
  return s.cascade.filter((x) => x === 'messages').length === 1 && s.setNull.includes('messages');
}));

// ---- SQL DDL → DBML 추출 (importer) 스모크 ----
// 앱의 "SQL에서 추출"과 같은 경로: importer 변환 결과가 자체 파서·시맨틱까지 통과해야 한다.

check('postgres DDL → DBML → 파서 왕복', (() => {
  const dbml = importer.import(`
    CREATE TABLE users (id uuid PRIMARY KEY, email varchar(255) UNIQUE NOT NULL);
    CREATE TABLE posts (
      id uuid PRIMARY KEY,
      author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title varchar(300)
    );`, 'postgres');
  const mo = parseDbml(dbml);
  const s = Semantics.analyze(mo);
  const ref = mo.refs.find((r) => r.child.table === 'posts');
  return mo.tables.length === 2 && !!ref && ref.kind === 'real' &&
    s.refMeta[ref.id]?.type === 'auth'; // author_id → 작성 관계로 분류
})());

check('mysql DDL → DBML → 파서 왕복', (() => {
  const dbml = importer.import(`
    CREATE TABLE teams (id int PRIMARY KEY AUTO_INCREMENT, name varchar(100));
    CREATE TABLE members (
      id int PRIMARY KEY AUTO_INCREMENT,
      team_id int NOT NULL,
      FOREIGN KEY (team_id) REFERENCES teams(id)
    ) ENGINE=InnoDB;`, 'mysql');
  const mo = parseDbml(dbml);
  return mo.tables.length === 2 &&
    mo.refs.some((r) => r.child.table === 'members' && r.parent.table === 'teams');
})());

check('잘못된 SQL은 예외로 표면화(조용한 성공 금지)', (() => {
  try { importer.import('CREATE TABEL broken (', 'postgres'); return false; }
  catch { return true; }
})());

// ---- 스키마 비교(diffModels) ----
// 두 리비전의 모델을 맞대어 테이블·컬럼·관계의 추가/삭제/변경을 낸다.
// 경계 규칙: 테이블 상태는 그 테이블 "자신의 정의"만 반영한다. 관계 변경은 관계선이 표현하므로
// 양 끝 테이블을 물들이지 않는다(안 그러면 관계 하나 바뀔 때 다이어그램 절반이 변경으로 보인다).
const D = (a: string, b: string) => diffModels(parseDbml(a), parseDbml(b));

const FX = `Table users { id int [pk]\n email varchar(255) [not null] }
Table posts { id int [pk]\n user_id int }
Ref: posts.user_id > users.id [delete: cascade]`;

check('diffModels export', typeof diffModels === 'function');

check('같은 모델이면 전부 same, 요약은 0', t(() => {
  const d = D(FX, FX);
  const s = d.summary;
  return Object.values(d.tables).every((x) => x.status === 'same') &&
    Object.values(d.refs).every((x) => x.status === 'same') &&
    s.tables.added === 0 && s.tables.removed === 0 && s.tables.changed === 0 &&
    s.refs.added === 0 && s.refs.removed === 0 && s.refs.changed === 0;
}));

check('테이블 추가', t(() => {
  const d = D(FX, FX + `\nTable likes { id int [pk] }`);
  return d.tables.likes?.status === 'added' && d.summary.tables.added === 1;
}));

check('테이블 삭제', t(() => {
  const d = D(FX + `\nTable tags { id int [pk] }`, FX);
  return d.tables.tags?.status === 'removed' && d.summary.tables.removed === 1;
}));

check('테이블이 사라지면 그 테이블의 관계도 삭제로 잡힌다', t(() => {
  const d = D(FX, `Table users { id int [pk]\n email varchar(255) [not null] }`);
  return d.tables.posts?.status === 'removed' &&
    d.refs['posts.user_id->users.id']?.status === 'removed';
}));

check('컬럼 추가 → 테이블 변경 + 컬럼 추가', t(() => {
  const d = D(FX, FX.replace('user_id int }', 'user_id int\n slug varchar(80) }'));
  const p = d.tables.posts;
  return p?.status === 'changed' && p.reasons?.includes('cols') && p.cols.slug?.status === 'added';
}));

check('컬럼 삭제', t(() => {
  const d = D(FX.replace('user_id int }', 'user_id int\n legacy int }'), FX);
  return d.tables.posts?.cols.legacy?.status === 'removed';
}));

check('타입 변경 → 이유 type, 전후 값 보존', t(() => {
  const d = D(FX, FX.replace('user_id int }', 'user_id bigint }'));
  const c = d.tables.posts?.cols.user_id;
  return c?.status === 'changed' && c.reasons?.includes('type') &&
    c.before?.type === 'int' && c.after?.type === 'bigint';
}));

check('NOT NULL 변경', t(() => {
  const d = D(FX, FX.replace('user_id int }', 'user_id int [not null] }'));
  return d.tables.posts?.cols.user_id?.reasons?.includes('notNull');
}));

check('기본값 변경', t(() => {
  const d = D(FX, FX.replace('user_id int }', 'user_id int [default: 0] }'));
  return d.tables.posts?.cols.user_id?.reasons?.includes('dflt');
}));

check('UNIQUE 변경', t(() => {
  const d = D(FX, FX.replace('user_id int }', 'user_id int [unique] }'));
  return d.tables.posts?.cols.user_id?.reasons?.includes('unique');
}));

check('PK 변경은 컬럼 이유 pk + 테이블 이유 pkCols', t(() => {
  const d = D(`Table t { a int [pk]\n b int }`, `Table t { a int\n b int [pk] }`);
  return d.tables.t?.cols.b?.reasons?.includes('pk') && d.tables.t?.reasons?.includes('pkCols');
}));

check('컬럼 설명(note) 변경도 변경으로 잡는다', t(() => {
  const d = D(`Table t { a int [note: '작성자'] }`, `Table t { a int [note: '담당자'] }`);
  return d.tables.t?.cols.a?.reasons?.includes('note');
}));

check('그룹 이동 → 테이블 변경, 이유 group', t(() => {
  const d = D(FX + `\nTableGroup g { users }`, FX + `\nTableGroup g { users\n posts }`);
  return d.tables.posts?.status === 'changed' && d.tables.posts?.reasons?.includes('group');
}));

check('관계 추가', t(() => {
  const d = D(FX, FX + `\nRef: posts.id - users.id`);
  return d.summary.refs.added === 1;
}));

check('관계 삭제', t(() => {
  const d = D(FX, FX.split('\nRef:')[0] ?? '');
  return d.refs['posts.user_id->users.id']?.status === 'removed' && d.summary.refs.removed === 1;
}));

check('삭제 동작 변경 → 관계 변경, 이유 onDelete', t(() => {
  const d = D(FX, FX.replace('[delete: cascade]', '[delete: set null]'));
  const r = d.refs['posts.user_id->users.id'];
  return r?.status === 'changed' && r.reasons?.includes('onDelete') &&
    r.before?.onDelete === 'cascade' && r.after?.onDelete === 'set null';
}));

check('실 FK ↔ 논리 FK 전환 → 이유 kind', t(() => {
  const d = D(FX, FX.replace('[delete: cascade]', '[delete: cascade] // logical'));
  return d.refs['posts.user_id->users.id']?.reasons?.includes('kind');
}));

check('관계 컬럼이 바뀌면 옛 관계 삭제 + 새 관계 추가', t(() => {
  const before = `Table users { id int [pk] }
Table posts { id int [pk]\n user_id int\n author_id int }
Ref: posts.user_id > users.id`;
  const after = `Table users { id int [pk] }
Table posts { id int [pk]\n user_id int\n author_id int }
Ref: posts.author_id > users.id`;
  const d = diffModels(parseDbml(before), parseDbml(after));
  return d.refs['posts.user_id->users.id']?.status === 'removed' &&
    d.refs['posts.author_id->users.id']?.status === 'added';
}));

check('관계만 바뀌면 양 끝 테이블은 same 유지', t(() => {
  const d = D(FX, FX.replace('[delete: cascade]', '[delete: restrict]'));
  return d.tables.users?.status === 'same' && d.tables.posts?.status === 'same';
}));

check('요약 카운트 합산', t(() => {
  const after = `Table users { id int [pk]\n email varchar(255) [not null] }
Table posts { id int [pk]\n user_id bigint }
Table likes { id int [pk] }
Ref: posts.user_id > users.id [delete: cascade]`;
  const d = diffModels(parseDbml(FX), parseDbml(after));
  const s = d.summary;
  return s.tables.added === 1 && s.tables.changed === 1 && s.tables.removed === 0 && s.refs.changed === 0;
}));

// ---- 로컬 전용 추가 회귀(저장소 미포함 스키마 대상, 있을 때만) ----
// 로컬 전용 회귀는 저장소의 scripts/에 있고 빌드 대상이 아니다 — 런타임에 직접 읽는다
const localPath = path.join(ROOT, 'scripts', 'check-local.js');
if (fs.existsSync(localPath)) {
  console.log('\n-- 로컬 회귀 (scripts/check-local.js) --');
  createRequire(__filename)(localPath)({ check, parseDbmlFile, Semantics });
}

// ---- 카드에 보여줄 컬럼 고르기(visibleCols) ----
// 불변식: 바뀐 컬럼은 어떤 경우에도 접히지 않는다. 변경을 색으로 알리는 화면에서 정작 바뀐 줄이
// 숨으면 "왜 이 테이블이 노랑인지" 알 길이 없다. 자리가 모자라면 키 컬럼부터 접는다.
// 픽스처는 관심 있는 필드만 적고 나머지는 여기서 채운다
const col = (c: Partial<Column> & { name: string }): Column =>
  ({ type: 'int', pk: false, unique: false, notNull: false, note: null, dflt: null, ...c });
const mkCols = (n: number, extra?: (Partial<Column> & { name: string })[]): Column[] => {
  const cols: Column[] = [];
  for (let i = 1; i <= n; i++) cols.push(col({ name: `k${i}`, unique: true }));
  for (const e of extra || []) cols.push(col(e));
  return cols;
};
const tdOf = (map: Record<string, string>): Pick<TableDiff, 'cols'> =>
  ({ cols: Object.fromEntries(Object.entries(map).map(([k, v]) => [k, { status: v as TableDiff['cols'][string]['status'] }])) });

check('visibleCols export', typeof visibleCols === 'function');

check('바뀐 컬럼은 정원을 넘겨도 전부 살아남는다', t(() => {
  const cols = mkCols(20, [{ name: 'zzz', unique: false, pk: false }]);
  const v = visibleCols(cols, tdOf({ zzz: 'changed' }), { max: 12 });
  return v.includes('zzz') && v.length <= 12;
}));

check('자리가 모자라면 키 컬럼부터 접힌다', t(() => {
  const cols = mkCols(20);
  const v = visibleCols(cols, tdOf({}), { max: 12 });
  return v.length === 12 && v[0] === 'k1';
}));

check('바뀐 컬럼이 정원보다 많으면 키를 다 버리고 변경만 남긴다', t(() => {
  const cols = mkCols(5, Array.from({ length: 15 }, (_, i) => ({ name: `c${i}`, unique: false, pk: false })));
  const changed: Record<string, string> = {};
  for (let i = 0; i < 15; i++) changed[`c${i}`] = 'changed';
  const v = visibleCols(cols, tdOf(changed), { max: 12 });
  return v.length === 15 && v.every((n) => n.startsWith('c'));
}));

check('전체 컬럼 모드면 전부 보여준다', t(() => {
  const cols = mkCols(20);
  return visibleCols(cols, tdOf({}), { max: 12, colsMode: 'all' }).length === 20;
}));

check('FK 컬럼도 키로 쳐서 보여준다', t(() => {
  const cols = [col({ name: 'a' }), col({ name: 'ref_id' })];
  return visibleCols(cols, tdOf({}), { fkNames: new Set(['ref_id']) }).includes('ref_id');
}));

check('키도 변경도 없으면 앞쪽 몇 개라도 보여준다', t(() => {
  const cols = [col({ name: 'a' }), col({ name: 'b' }), col({ name: 'c' }), col({ name: 'd' })];
  const v = visibleCols(cols, tdOf({}), {});
  return v.length === 3 && v[0] === 'a';
}));

check('컬럼 순서는 원본을 따른다', t(() => {
  const cols = [col({ name: 'a', unique: true }), col({ name: 'b' }), col({ name: 'c', unique: true })];
  const v = visibleCols(cols, tdOf({ b: 'changed' }), { max: 12 });
  return v.join(',') === 'a,b,c';
}));

// ---- 컬럼 사실 수집(column-facts) ----
check('없는 테이블/컬럼은 null', t(() =>
  columnFacts(model, 'no_such_table', 'id') === null &&
  columnFacts(model, 'users', 'no_such_col') === null));

check('PK 컬럼의 기본값을 읽는다', t(() => {
  const f = columnFacts(model, 'users', 'id');
  return !!f && f.column.pk && f.column.notNull && f.column.dflt === 'gen_random_uuid()';
}));

check('unique 컬럼은 복합 UNIQUE로 세지 않는다', t(() => {
  const f = columnFacts(model, 'users', 'email');
  return !!f && f.column.unique && f.compositeUnique.length === 0 && f.fk === null;
}));

check('ref 없는 컬럼도 note는 살아 있다', t(() => {
  const f = columnFacts(model, 'users', 'workspace_id');
  return !!f && f.fk === null && /workspaces\.id/.test(f.column.note || '');
}));

check('선두 FK 컬럼은 role=lead', t(() => {
  const f = columnFacts(model, 'repos', 'owner_id');
  return !!f && f.fk?.role === 'lead' && f.fk.ref.parent.table === 'users';
}));

check('복합 FK의 후행 멤버는 role=member', t(() => {
  const mo = parseDbml(`Table p {
  a int
  b int
  indexes { (a, b) [pk] }
}
Table c {
  x int
  y int
}
Ref: c.(x, y) > p.(a, b)`);
  const lead = columnFacts(mo, 'c', 'x');
  const mem = columnFacts(mo, 'c', 'y');
  return lead?.fk?.role === 'lead' && mem?.fk?.role === 'member' &&
    mem?.fk?.ref.parent.table === 'p';
}));

check('복합 UNIQUE 소속을 컬럼별로 찾는다', t(() => {
  const mo = parseDbml(`Table t {
  a int
  b int
  c int
  indexes { (a, b) [unique] }
}`);
  const fa = columnFacts(mo, 't', 'a');
  const fc = columnFacts(mo, 't', 'c');
  return fa?.compositeUnique.length === 1 && fa.compositeUnique[0]?.join(',') === 'a,b' &&
    fc?.compositeUnique.length === 0;
}));

check('타입 이름이 enum과 같으면 정의를 붙인다', t(() => {
  const mo = parseDbml(`Enum st {
  OPEN
  CLOSED
}
Table t {
  id int [pk]
  s st
  plain varchar(20)
}`);
  const fs2 = columnFacts(mo, 't', 's');
  const fp = columnFacts(mo, 't', 'plain');
  return fs2?.enumDef?.name === 'st' && fs2.enumDef.values.length === 2 &&
    fs2.enumDef.values[0]?.name === 'OPEN' && fp?.enumDef === null;
}));

// ---- git 기준본 읽기 ----
// 실제 저장소를 상대로 확인한다(모킹 없음). CI 체크아웃도 git 저장소라 그대로 돈다.
// 비동기라 여기서부터 결과 출력까지를 한 블록으로 감싼다.
(async () => {

  const base = await gitBaseline(path.join(ROOT, 'assets', 'example.dbml'));
  const baseOk = isFailure(base) ? null : base;
  check('기준본: 커밋된 파일의 내용을 읽는다', !!baseOk?.text, isFailure(base) ? base.error : '');
  check('기준본: 읽은 내용이 파서를 통과한다', t(() => parseDbml(baseOk?.text ?? '').tables.length > 0));
  check('기준본: 이 파일을 마지막으로 바꾼 커밋 정보가 붙는다', !!baseOk?.sha && !!baseOk?.when);

  const outside = path.join(os.tmpdir(), `schema-lens-outside-${process.pid}.dbml`);
  fs.writeFileSync(outside, 'Table t { id int [pk] }');
  try {
    const r = await gitBaseline(outside);
    check('기준본: 저장소 밖 파일은 not-a-repo', isFailure(r) && r.error === 'not-a-repo');
  } finally { try { fs.unlinkSync(outside); } catch {} }

  const fresh = path.join(ROOT, 'scripts', `.tmp-uncommitted-${process.pid}.dbml`);
  fs.writeFileSync(fresh, 'Table t { id int [pk] }');
  try {
    const r = await gitBaseline(fresh);
    check('기준본: 커밋된 적 없는 파일은 untracked', isFailure(r) && r.error === 'untracked');
  } finally { try { fs.unlinkSync(fresh); } catch {} }

  const missing = await gitBaseline(path.join(ROOT, 'scripts', 'no-such-file.dbml'));
  check('기준본: 없는 파일은 no-file', isFailure(missing) && missing.error === 'no-file');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
