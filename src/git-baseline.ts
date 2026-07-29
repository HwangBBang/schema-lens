// 여는 .dbml 파일이 git 저장소 안이면 "마지막 커밋 시점의 내용"을 읽어온다.
// electron에 의존하지 않는 순수 Node 모듈 — 검증 스크립트에서 그대로 돌려볼 수 있게 분리했다.
//
// 셸을 거치지 않는 execFile을 쓴다. 경로에 공백·따옴표·글롭 문자가 있어도 그대로 안전하다.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export type BaselineError = 'no-file' | 'not-a-repo' | 'no-commit' | 'untracked';

export type BaselineText = {
  text: string;
  sha: string | null;
  subject: string | null;
  when: string | null;
};

export type BaselineFailure = {
  error: BaselineError;
  message: string;
};

export type BaselineResult = BaselineText | BaselineFailure;

/** 결과가 실패인지 — 호출부가 좁히기(narrowing)에 쓴다 */
export const isFailure = (r: BaselineResult): r is BaselineFailure => 'error' in r;

function git(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 10000 }, (err, stdout) =>
      (err ? reject(err) : resolve(stdout)));
  });
}

// 내용은 HEAD(=커밋된 상태)에서, 라벨용 메타는 "이 파일을 마지막으로 바꾼 커밋"에서 가져온다.
// 둘을 나눈 이유: 맞대어 볼 내용은 지금 파일 기준이라 HEAD가 맞지만, 사용자가 알고 싶은 시점은
// 이 파일이 마지막으로 바뀐 때다. HEAD의 날짜를 보여주면 남의 커밋 날짜가 찍힌다.
export async function gitBaseline(filePath: string | null): Promise<BaselineResult> {
  if (!filePath || !fs.existsSync(filePath)) return { error: 'no-file', message: '열린 파일이 없습니다' };
  const dir = path.dirname(filePath);
  let root: string;
  try { root = (await git(['rev-parse', '--show-toplevel'], dir)).trim(); }
  catch { return { error: 'not-a-repo', message: '이 파일은 git 저장소 안에 있지 않습니다' }; }
  try { await git(['rev-parse', '--verify', 'HEAD'], root); }
  catch { return { error: 'no-commit', message: '저장소에 아직 커밋이 없습니다' }; }
  const rel = path.relative(root, filePath).split(path.sep).join('/');
  let text: string;
  try { text = await git(['show', `HEAD:${rel}`], root); }
  catch { return { error: 'untracked', message: '이 파일은 아직 커밋된 적이 없습니다' }; }
  let sha: string | null = null, subject: string | null = null, when: string | null = null;
  try {
    const out = await git(['log', '-1', '--format=%h%x00%s%x00%cI', '--', rel], root);
    const parts = out.trim().split('\0');
    sha = parts[0] ?? null;
    subject = parts[1] ?? null;
    when = parts[2] ?? null;
  } catch { /* 메타를 못 읽어도 비교 자체는 된다 */ }
  return { text, sha, subject, when };
}
