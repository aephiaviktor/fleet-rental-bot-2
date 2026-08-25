const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fleetRentalBot', {
  getBootstrap: () => ipcRenderer.invoke('app:get-bootstrap'),
  loadWatchlist: () => ipcRenderer.invoke('watchlist:load'),
  saveWatchlist: (document) => ipcRenderer.invoke('watchlist:save', document),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getRpcLimiterStatus: () => ipcRenderer.invoke('rpc-limiter:status'),
  refreshWatchlist: () => ipcRenderer.invoke('watchlist:refresh'),
  prepareReservationReview: (entryId) => ipcRenderer.invoke('reservation:review', entryId),
  simulateReservation: (entryId) => ipcRenderer.invoke('reservation:simulate', entryId),
});
