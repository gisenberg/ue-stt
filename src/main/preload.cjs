const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recordings', {
  list: () => ipcRenderer.invoke('recordings:list'),
  saveAudio: (payload) => ipcRenderer.invoke('recordings:saveAudio', payload),
  transcribeAndSave: (payload) => ipcRenderer.invoke('recordings:transcribeAndSave', payload),
  transcribeExisting: (id) => ipcRenderer.invoke('recordings:transcribeExisting', id),
  transcribeChunk: (payload) => ipcRenderer.invoke('recordings:transcribeChunk', payload),
  readMarkdown: (id, options) => ipcRenderer.invoke('recordings:readMarkdown', id, options),
  readAudio: (id) => ipcRenderer.invoke('recordings:readAudio', id),
  reveal: (id, options) => ipcRenderer.invoke('recordings:reveal', id, options),
  openWithCode: (id, options) => ipcRenderer.invoke('recordings:openWithCode', id, options),
  copyPath: (id, options) => ipcRenderer.invoke('recordings:copyPath', id, options),
  renameMarkdown: (id, name) => ipcRenderer.invoke('recordings:renameMarkdown', id, name),
  refineWithCodex: (id, prompt) => ipcRenderer.invoke('recordings:refineWithCodex', id, prompt),
  updateRefinementPrompt: (id, refinementId, prompt) =>
    ipcRenderer.invoke('recordings:updateRefinementPrompt', id, refinementId, prompt),
  onTranscriptionProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('recordings:transcriptionProgress', listener);
    return () => ipcRenderer.removeListener('recordings:transcriptionProgress', listener);
  }
});

contextBridge.exposeInMainWorld('whisperEngine', {
  status: () => ipcRenderer.invoke('engine:status'),
  setBackend: (backend) => ipcRenderer.invoke('engine:setBackend', backend)
});

contextBridge.exposeInMainWorld('refinement', {
  getPrompt: () => ipcRenderer.invoke('refinement:getPrompt'),
  savePrompt: (prompt) => ipcRenderer.invoke('refinement:savePrompt', prompt)
});
