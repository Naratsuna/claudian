import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildLarkBridgeLaunchEnv,
  getLarkBridgeConfigPath,
  larkBridgeWorkspaceMatches,
  readLarkBridgeState,
} from '@/core/larkbridge/LarkBridgeConfig';

function makeBridgeHome(config: unknown): string {
  const home = mkdtempSync(join(tmpdir(), 'claudian-larkbridge-'));
  writeFileSync(getLarkBridgeConfigPath(home), JSON.stringify(config), 'utf8');
  return home;
}

const ROOT_CONFIG = {
  schemaVersion: 2,
  activeProfile: 'work',
  profiles: {
    work: {
      agentKind: 'claude',
      workspaces: { default: 'E:\\Repos\\work' },
    },
    bot: {
      agentKind: 'codex',
      codex: { binaryPath: 'codex' },
    },
    isolated: {
      agentKind: 'codex',
      codex: { binaryPath: 'codex', inheritCodexHome: false },
    },
    pinned: {
      agentKind: 'codex',
      codex: { binaryPath: 'codex', codexHome: 'D:\\codex-home' },
    },
    broken: { agentKind: 'gemini' },
  },
};

afterEach(() => {
  rmSync(join(tmpdir(), 'claudian-larkbridge-'), { recursive: true, force: true });
});

describe('readLarkBridgeState', () => {
  it('reports not-installed when config.json is missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'claudian-larkbridge-'));
    const state = readLarkBridgeState(home);
    expect(state.status).toBe('not-installed');
    expect(state.profiles).toEqual([]);
    expect(state.configPath).toBe(getLarkBridgeConfigPath(home));
  });

  it('reports invalid-config for malformed JSON and wrong schema versions', () => {
    const home = mkdtempSync(join(tmpdir(), 'claudian-larkbridge-'));
    writeFileSync(getLarkBridgeConfigPath(home), '{not json', 'utf8');
    expect(readLarkBridgeState(home).status).toBe('invalid-config');

    writeFileSync(getLarkBridgeConfigPath(home), JSON.stringify({ schemaVersion: 1 }), 'utf8');
    expect(readLarkBridgeState(home).status).toBe('invalid-config');
  });

  it('keeps valid claude/codex profiles and skips malformed entries', () => {
    const state = readLarkBridgeState(makeBridgeHome(ROOT_CONFIG));
    expect(state.status).toBe('ready');
    expect(state.profiles.map((profile) => profile.name)).toEqual([
      'bot',
      'isolated',
      'pinned',
      'work',
    ]);
    const work = state.profiles.find((profile) => profile.name === 'work');
    expect(work?.agentKind).toBe('claude');
    expect(work?.defaultWorkspace).toBe('E:\\Repos\\work');
  });
});

describe('buildLarkBridgeLaunchEnv', () => {
  it('returns null for unknown profiles, kind mismatches, and missing configs', () => {
    const home = makeBridgeHome(ROOT_CONFIG);
    expect(buildLarkBridgeLaunchEnv(home, 'missing', 'claude')).toBeNull();
    expect(buildLarkBridgeLaunchEnv(home, 'work', 'codex')).toBeNull();
    expect(buildLarkBridgeLaunchEnv(makeBridgeHome({ schemaVersion: 1 }), 'work', 'claude')).toBeNull();
    expect(buildLarkBridgeLaunchEnv(home, '', 'claude')).toBeNull();
  });

  it('replicates the bridge claude env contract', () => {
    const home = makeBridgeHome(ROOT_CONFIG);
    expect(buildLarkBridgeLaunchEnv(home, 'work', 'claude')).toEqual({
      LARK_CHANNEL: '1',
      LARK_CHANNEL_PROFILE: 'work',
      LARK_CHANNEL_HOME: home,
      LARK_CHANNEL_CONFIG: getLarkBridgeConfigPath(home),
      LARKSUITE_CLI_CONFIG_DIR: join(home, 'profiles', 'work', 'lark-cli'),
    });
  });

  it('prefers the lark-cli-source projection file when it exists', () => {
    const home = makeBridgeHome(ROOT_CONFIG);
    const sourceConfig = join(home, 'profiles', 'work', 'lark-cli-source', 'config.json');
    mkdirSync(join(home, 'profiles', 'work', 'lark-cli-source'), { recursive: true });
    writeFileSync(sourceConfig, '{}', 'utf8');
    expect(buildLarkBridgeLaunchEnv(home, 'work', 'claude')?.LARK_CHANNEL_CONFIG).toBe(sourceConfig);
  });

  it('sets CODEX_HOME only when the profile demands it', () => {
    const home = makeBridgeHome(ROOT_CONFIG);
    // inherit (default): no CODEX_HOME, matching the bridge
    expect(buildLarkBridgeLaunchEnv(home, 'bot', 'codex')?.CODEX_HOME).toBeUndefined();
    // inheritCodexHome: false → isolated profile home
    expect(buildLarkBridgeLaunchEnv(home, 'isolated', 'codex')?.CODEX_HOME)
      .toBe(join(home, 'profiles', 'isolated', 'codex-home'));
    // explicit codexHome wins
    expect(buildLarkBridgeLaunchEnv(home, 'pinned', 'codex')?.CODEX_HOME).toBe('D:\\codex-home');
  });
});

describe('larkBridgeWorkspaceMatches', () => {
  it('normalizes separators, case, and trailing separators', () => {
    const cases: Array<[string, string, boolean]> = process.platform === 'win32'
      ? [
        ['E:/repos/work/', 'E:\\Repos\\work', true],
        ['E:\\other', 'E:\\Repos\\work', false],
      ]
      : [
        ['/repos/work/', '/repos/work', true],
        ['/repos/other', '/repos/work', false],
      ];
    for (const [workspace, vault, expected] of cases) {
      expect(larkBridgeWorkspaceMatches(workspace, vault)).toBe(expected);
    }
  });

  it('returns null when the profile has no default workspace', () => {
    expect(larkBridgeWorkspaceMatches(undefined, 'E:\\vault')).toBeNull();
    expect(larkBridgeWorkspaceMatches('  ', 'E:\\vault')).toBeNull();
  });
});
