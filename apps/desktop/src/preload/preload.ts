import { contextBridge, ipcRenderer } from 'electron';
import { type DesktopBridge, IPC } from '../shared/bridge';

// Sandboxed preload (contextIsolation + sandbox, DT-08): the page gets plain functions — never
// ipcRenderer itself, and never a way to name a path (it can only pass a project id, which the
// main process looks up in the API's own list).
const bridge: DesktopBridge = {
  platform: process.platform,
  project: {
    add: () => ipcRenderer.invoke(IPC.projectAdd),
    reveal: (id: string) => ipcRenderer.invoke(IPC.projectReveal, String(id)),
  },
  bundle: {
    sign: (projectId: string, gate: string, locale: string) =>
      ipcRenderer.invoke(
        IPC.bundleSign,
        String(projectId),
        String(gate),
        String(locale),
      ),
  },
};

contextBridge.exposeInMainWorld('moatDesktop', bridge);
