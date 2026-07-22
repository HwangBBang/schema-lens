const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('dbv', {
  onModel: (cb) => ipcRenderer.on('model', (_e, payload) => cb(payload)),
  onResetLayout: (cb) => ipcRenderer.on('reset-layout', () => cb()),
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  openPath: (p) => ipcRenderer.send('open-path', p),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },
  renderDone: (info) => ipcRenderer.send('render-done', info || null),
});
