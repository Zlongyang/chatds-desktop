const { contextBridge, ipcRenderer } = require('electron');
const names = [
  'state',
  'configure',
  'chat',
  'history',
  'conversation',
  'stop',
  'memories',
  'forget',
  'approve',
  'approveFriend',
  'modelTest',
  'testAndSaveModel',
  'connect',
  'disconnect',
  'napcatBegin',
  'napcatChooseInstallation',
  'napcatInstallPackage',
  'napcatCancelInstall',
  'openQQDownload',
  'napcatForgetInstallation',
  'napcatLaunch',
  'napcatCheck',
  'napcatPoll',
  'napcatBind',
  'napcatCancel',
  'napcatGuide',
  'sandboxCheck',
  'chooseSkill',
  'removeSkill',
  'skills',
  'chooseImport',
  'openData',
  'loginStartup',
];
const api = Object.fromEntries(
  names.map((name) => [name, (...args) => ipcRenderer.invoke('chatds:' + name, ...args)]),
);
api.onEvent = (listener) => {
  const fn = (_event, value) => listener(value);
  ipcRenderer.on('chatds:event', fn);
  return () => ipcRenderer.removeListener('chatds:event', fn);
};
contextBridge.exposeInMainWorld('chatds', Object.freeze(api));
