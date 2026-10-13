/**
 * The moat.yaml of a new project (Moat Desktop «Neues Projekt», FR-73): valid as it is, one
 * environment for the first gate, no upstreams and no routes yet. Comments say where things go;
 * the edits of config/edit.ts keep them.
 */
export const NEW_PROJECT_CONFIG = `# Moat project: upstreams, routes and environments of your gates.
# Secrets never go into this file. Moat Desktop seals them for each gate.
version: 1

environments:
  production:
    enabled: true

upstreams: {}

routes: {}
`;
