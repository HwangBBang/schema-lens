const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('dbv', {
  onModel: (cb) => ipcRenderer.on('model', (_e, payload) => cb(payload)),
  onResetLayout: (cb) => ipcRenderer.on('reset-layout', () => cb()),
  onShowView: (cb) => ipcRenderer.on('show-view', (_e, v) => cb(v)),
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  openPath: (p) => ipcRenderer.send('open-path', p),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },
  renderDone: (info) => ipcRenderer.send('render-done', info || null),
  libraryList: () => ipcRenderer.invoke('library-list'),
  libraryRemove: (p) => ipcRenderer.invoke('library-remove', p),
  extractConvert: (sql, dialect) => ipcRenderer.invoke('extract-convert', { sql, dialect }),
  extractSave: (dbml) => ipcRenderer.invoke('extract-save', dbml),
  openSqlDialog: () => ipcRenderer.invoke('open-sql-dialog'),
});
