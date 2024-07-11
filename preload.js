const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  startFetching: (interval) => ipcRenderer.send('start-fetching', interval),
  stopFetching: () => ipcRenderer.send('stop-fetching'),
  onFetchResult: (callback) => ipcRenderer.on('fetch-result', (event, data) => callback(data)),
});