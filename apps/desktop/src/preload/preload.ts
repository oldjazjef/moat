import { contextBridge, ipcRenderer } from 'electron';
import { type DesktopBridge, IPC } from '../shared/bridge';

// Sandboxed preload (contextIsolation + sandbox, DT-08): the page gets plain functions without
// arguments — never ipcRenderer itself, and never a way to name a path.
const bridge: DesktopBridge = {
  platform: process.platform,
  project: {
    choose: () => ipcRenderer.invoke(IPC.projectChoose),
    reveal: () => ipcRenderer.invoke(IPC.projectReveal),
  },
};

contextBridge.exposeInMainWorld('moatDesktop', bridge);
