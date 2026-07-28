import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('dbv', {
  onModel: (cb: (payload: unknown) => void) => ipcRenderer.on('model', (_e, payload) => cb(payload)),
  onResetLayout: (cb: () => void) => ipcRenderer.on('reset-layout', () => cb()),
  onShowView: (cb: (v: string) => void) => ipcRenderer.on('show-view', (_e, v: string) => cb(v)),
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  openPath: (p: string) => ipcRenderer.send('open-path', p),
  pathForFile: (file: File) => { try { return webUtils.getPathForFile(file); } catch { return null; } },
  renderDone: (info?: { error?: boolean }) => ipcRenderer.send('render-done', info || null),
  libraryList: () => ipcRenderer.invoke('library-list'),
  libraryRemove: (p: string) => ipcRenderer.invoke('library-remove', p),
  extractConvert: (sql: string, dialect: string) => ipcRenderer.invoke('extract-convert', { sql, dialect }),
  extractSave: (dbml: string) => ipcRenderer.invoke('extract-save', dbml),
  openSqlDialog: () => ipcRenderer.invoke('open-sql-dialog'),
  gitBaseline: () => ipcRenderer.invoke('git-baseline'),
});
