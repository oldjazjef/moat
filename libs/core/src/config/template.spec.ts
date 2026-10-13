import { addEnvironment, assignGate, setRoute, setUpstream } from './edit';
import { NEW_PROJECT_CONFIG } from './template';
import { loadMoatYaml } from './yaml';

describe('NEW_PROJECT_CONFIG (FR-73)', () => {
  it('is a valid moat.yaml with one environment and nothing else', () => {
    const config = loadMoatYaml(NEW_PROJECT_CONFIG);
    expect(Object.keys(config.environments ?? {})).toEqual(['production']);
    expect(config.upstreams).toEqual({});
    expect(config.routes).toEqual({});
  });

  it('takes the first edits in block style and keeps its comments', () => {
    let text = assignGate(NEW_PROJECT_CONFIG, 'www', 'production');
    text = addEnvironment(text, 'staging');
    text = setUpstream(
      text,
      'hubspot',
      { origin: 'https://api.hubapi.com' },
      'create',
    );
    text = setRoute(
      text,
      'newsletter',
      {
        method: 'POST',
        path: '/newsletter',
        upstream: 'hubspot',
        upstreamPath: '/contacts',
      },
      'create',
    );
    expect(text).toContain('# Secrets never go into this file.');
    expect(text).not.toMatch(/\{\s*\w/);
    const config = loadMoatYaml(text);
    expect(config.gates).toEqual({ www: { environment: 'production' } });
    expect(Object.keys(config.routes)).toEqual(['newsletter']);
  });
});
