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

// ---- 로컬 전용 추가 회귀(저장소 미포함 스키마 대상, 있을 때만) ----
const localPath = path.join(__dirname, 'check-local.js');
if (fs.existsSync(localPath)) {
  console.log('\n-- 로컬 회귀 (scripts/check-local.js) --');
  require(localPath)({ check, parseDbmlFile, Semantics });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
