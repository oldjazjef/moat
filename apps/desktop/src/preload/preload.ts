import { contextBridge, ipcRenderer } from 'electron';
import { type DesktopBridge, IPC } from '../shared/bridge';

// Sandboxed preload (contextIsolation + sandbox, DT-08): the page gets plain functions — never
// ipcRenderer itself, and never a way to name a path (it can only pass a project id, which the
// main process looks up in the API's own list).
const bridge: DesktopBridge = {
  platform: process.platform,
  project: {
    add: () => ipcRenderer.invoke(IPC.projectAdd),
    create: () => ipcRenderer.invoke(IPC.projectCreate),
    reveal: (id: string) => ipcRenderer.invoke(IPC.projectReveal, String(id)),
  },
  key: {
    status: () => ipcRenderer.invoke(IPC.keyStatus),
    choose: () => ipcRenderer.invoke(IPC.keyChoose),
    rotationDone: (locale: string) =>
      ipcRenderer.invoke(IPC.keyRotationDone, String(locale)),
    create: (locale: string) =>
      ipcRenderer.invoke(IPC.keyCreate, String(locale)),
  },
  secret: {
    seal: (projectId: string, gate: string, name: string, locale: string) =>
      ipcRenderer.invoke(
        IPC.secretSeal,
        String(projectId),
        String(gate),
        String(name),
        String(locale),
      ),
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
  gate: {
    deploy: (projectId: string, gate: string, target: string, locale: string) =>
      ipcRenderer.invoke(
        IPC.gateDeploy,
        String(projectId),
        String(gate),
        String(target),
        String(locale),
      ),
    import: (projectId: string, gate: string, from: string, locale: string) =>
      ipcRenderer.invoke(
        IPC.gateImport,
        String(projectId),
        String(gate),
        String(from),
        String(locale),
      ),
    log: (projectId: string, gate: string, locale: string) =>
      ipcRenderer.invoke(
        IPC.gateLog,
        String(projectId),
        String(gate),
        String(locale),
      ),
  },
  passkey: {
    status: (projectId: string) =>
      ipcRenderer.invoke(IPC.passkeyStatus, String(projectId)),
    enroll: (locale: string) =>
      ipcRenderer.invoke(IPC.passkeyEnroll, String(locale)),
    use: (projectId: string, gate: string, on: boolean, locale: string) =>
      ipcRenderer.invoke(
        IPC.passkeyUse,
        String(projectId),
        String(gate),
        on === true,
        String(locale),
      ),
  },
  database: {
    open: (projectId: string, locale: string) =>
      ipcRenderer.invoke(IPC.databaseOpen, String(projectId), String(locale)),
  },
};

contextBridge.exposeInMainWorld('moatDesktop', bridge);
