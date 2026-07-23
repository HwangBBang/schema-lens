// assets/example.dbml을 파싱해 설계 시점에 확정한 기대값(ground truth)과 대조하고,
// "// logical" 프리패스·조인 휴리스틱의 엣지케이스를 인라인 픽스처로 회귀 테스트한다.
// 실행: npm test
const fs = require('fs');
const path = require('path');
const { parseDbml, parseDbmlFile } = require('../src/parse');
const Semantics = require('../src/semantics');

const model = parseDbmlFile(path.join(__dirname, '..', 'assets', 'example.dbml'));
const sem = Semantics.analyze(model);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function refOf(childTable, childCol) {
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
check('users.email unique', !!users && users.cols.find((c) => c.name === 'email').unique);
check('컬럼 note 보존', !!users && /workspaces\.id/.test(users.cols.find((c) => c.name === 'workspace_id').note || ''));

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
  const r = refOf(t, c);
  const got = r && sem.refMeta[r.id].type;
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
  sem.tableMeta['wiki_page_links'].junction === 'multi');

// ---- 카디널리티 ----
check('repo_insights 1:1', insightsRef && sem.refMeta[insightsRef.id].card === '1:1');
const assigneeRef = refOf('issues', 'assignee_id');
check('issues.assignee_id N:1', assigneeRef && sem.refMeta[assigneeRef.id].card === 'N:1');

// ---- 허브 ----
check('users 허브 감지(유입 21)', sem.hubs.some((h) => h.table === 'users' && h.inDegree === 21),
  JSON.stringify(sem.hubs));
check('repos는 허브 아님(유입 8이지만 사람비율 미달)', !sem.hubs.some((h) => h.table === 'repos'));
check('issues는 허브 아님', !sem.hubs.some((h) => h.table === 'issues'));

// ---- 라벨(컬럼 note에서 추출) ----
check('라벨 issues.assignee_id=담당자', assigneeRef && sem.refMeta[assigneeRef.id].label === '담당자',
  assigneeRef && sem.refMeta[assigneeRef.id].label);

// ---- 프리패스 엣지케이스 (인라인 픽스처) ----
function kindOf(dbml, childTable, childCol) {
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
  return simple.kind === 'logical' && comp.kind === 'real';
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
  catch (e) { return typeof e.message === 'string' && e.message !== '[object Object]' && e.message.length > 3; }
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
const t = (fn) => { try { return fn(); } catch (e) { return false; } };
const ao = Semantics.actionOf;

check('actionOf export', typeof ao === 'function');
check('ACTIONS 6종 계약(label·cssVar)', t(() =>
  ['cascade', 'set null', 'set default', 'restrict', 'no action', 'unknown']
    .every((k) => Semantics.ACTIONS[k] && Semantics.ACTIONS[k].label && Semantics.ACTIONS[k].cssVar)));
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
  return s.refMeta[r.id].onDelete.action === 'cascade' && s.refMeta[r.id].onUpdate.specified === false;
}));

// ---- 삭제 영향(deleteImpact) 인라인 픽스처 ----
const di = (dbml, root) => Semantics.deleteImpact(parseDbml(dbml), root);
const flatten = (entries) => {
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

// ---- 로컬 전용 추가 회귀(저장소 미포함 스키마 대상, 있을 때만) ----
const localPath = path.join(__dirname, 'check-local.js');
if (fs.existsSync(localPath)) {
  console.log('\n-- 로컬 회귀 (scripts/check-local.js) --');
  require(localPath)({ check, parseDbmlFile, Semantics });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
