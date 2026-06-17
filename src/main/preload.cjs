const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recordings', {
  list: () => ipcRenderer.invoke('recordings:list'),
  saveAudio: (payload) => ipcRenderer.invoke('recordings:saveAudio', payload),
  transcribeAndSave: (payload) => ipcRenderer.invoke('recordings:transcribeAndSave', payload),
  transcribeExisting: (id) => ipcRenderer.invoke('recordings:transcribeExisting', id),
  transcribeChunk: (payload) => ipcRenderer.invoke('recordings:transcribeChunk', payload),
  readMarkdown: (id) => ipcRenderer.invoke('recordings:readMarkdown', id),
  readAudio: (id) => ipcRenderer.invoke('recordings:readAudio', id),
  reveal: (id) => ipcRenderer.invoke('recordings:reveal', id),
  renameMarkdown: (id, name) => ipcRenderer.invoke('recordings:renameMarkdown', id, name),
  refineWithCodex: (id, prompt) => ipcRenderer.invoke('recordings:refineWithCodex', id, prompt)
});

contextBridge.exposeInMainWorld('whisperEngine', {
  status: () => ipcRenderer.invoke('engine:status')
});

contextBridge.exposeInMainWorld('refinement', {
  getPrompt: () => ipcRenderer.invoke('refinement:getPrompt'),
  savePrompt: (prompt) => ipcRenderer.invoke('refinement:savePrompt', prompt)
});
