// 렌더러가 공유하는 타입: 앱 상태와 preload 다리.
//
// 앱 상태(S)는 app.ts가 만들어 ERD·포커스·비교에 그대로 넘긴다. 세 화면이 같은 객체를 보고
// 서로의 변경을 즉시 읽는 구조라, 필드가 늘면 여기부터 고쳐야 한다.

import type { Model } from '../src/model.ts';
import type { Analysis } from '../src/semantics.ts';

export type Mode = 'erd' | 'focus' | 'diff';
export type Filter = 'all' | 'real';
export type ColsMode = 'keys' | 'all';

export type AppState = {
  model: Model | null;
  sem: Analysis | null;
  filePath: string | null;
  mode: Mode;
  focusTable: string | null;
  /** 실제로 렌더된 적 있는 포커스 — 히스토리는 이것만 쌓는다 */
  lastFocus: string | null;
  hist: string[];
  filter: Filter;
  colsMode: ColsMode;
  /** 허브 테이블별 엣지 펼침 여부 */
  hubShown: Record<string, boolean>;
  selected: string | null;
  /** 그룹명 → CSS 색 변수 이름 */
  groupColor: Record<string, string>;
  /** 삭제 영향 모드 — go() 이동에도 유지, 파일 교체 시 리셋 */
  impact: boolean;
};

/** main이 렌더러로 보내는 모델 페이로드 (CLI 오버라이드 포함) */
export type ModelPayload = {
  model: Model | null;
  path: string;
  focus: string | null;
  theme: string | null;
  side: string | null;
  layout: string | null;
  peek: string | null;
  impact: boolean;
  cols: string | null;
  diff: boolean;
  error: string | null;
};

export type LibraryEntry = {
  name: string;
  path: string;
  addedAt: string;
  lastOpenedAt?: string;
  stats?: { tables: number; refs: number };
  missing?: boolean;
};

export type BaselinePayload =
  | { model: Model; sha: string | null; subject: string | null; when: string | null }
  | { error: string; message: string };

/** preload.ts가 contextBridge로 노출하는 다리 */
export type Dbv = {
  onModel(cb: (payload: ModelPayload) => void): void;
  onResetLayout(cb: () => void): void;
  onShowView(cb: (v: string) => void): void;
  openFileDialog(): Promise<void>;
  openPath(p: string): void;
  pathForFile(file: File): string | null;
  renderDone(info?: { error?: boolean }): void;
  libraryList(): Promise<LibraryEntry[]>;
  libraryRemove(p: string): Promise<boolean>;
  extractConvert(sql: string, dialect: string): Promise<{ dbml?: string; error?: string }>;
  extractSave(dbml: string): Promise<{ path?: string; canceled?: boolean; error?: string }>;
  openSqlDialog(): Promise<string | null>;
  gitBaseline(): Promise<BaselinePayload>;
};

declare global {
  interface Window {
    dbv: Dbv;
  }
}
