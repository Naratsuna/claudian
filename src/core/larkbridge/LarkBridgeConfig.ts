import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Read-only access to lark-channel-bridge (飞书桥接) profile configuration.
 *
 * The bridge stores its profiles in `<LARK_CHANNEL_HOME ?? ~/.lark-channel>/config.json`
 * as `RootConfig { schemaVersion: 2, profiles: Record<name, ProfileConfig> }`. This
 * module replicates the bridge's own launch-env contract (lark-channel-env.ts +
 * app-paths.ts in lark-coding-agent-bridge) so agents spawned from this plugin are
 * indistinguishable from bridge-spawned ones: same identity, same lark-cli config,
 * same session buckets (the default ~/.claude and ~/.codex homes are shared on
 * purpose — neither side sets CLAUDE_CONFIG_DIR).
 */

export type LarkBridgeAgentKind = 'claude' | 'codex';

export interface LarkBridgeProfileInfo {
  name: string;
  agentKind: LarkBridgeAgentKind;
  /** Fallback cwd for Feishu-side runs; individual chats can override via /cd. */
  defaultWorkspace?: string;
  /** Profile-level codex home override (profile.codex.codexHome). */
  codexHome?: string;
  /** False when the bridge isolates codex into profiles/<name>/codex-home. */
  inheritCodexHome: boolean;
}

export type LarkBridgeStatus = 'not-installed' | 'invalid-config' | 'ready';

export interface LarkBridgeState {
  status: LarkBridgeStatus;
  configPath: string;
  error?: string;
  profiles: LarkBridgeProfileInfo[];
}

export function resolveLarkChannelHome(): string {
  const override = process.env.LARK_CHANNEL_HOME?.trim();
  return override || join(homedir(), '.lark-channel');
}

export function getLarkBridgeConfigPath(home: string = resolveLarkChannelHome()): string {
  return join(home, 'config.json');
}

export function readLarkBridgeState(home: string = resolveLarkChannelHome()): LarkBridgeState {
  const configPath = getLarkBridgeConfigPath(home);
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    return { status: 'not-installed', configPath, profiles: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      status: 'invalid-config',
      configPath,
      error: err instanceof Error ? err.message : String(err),
      profiles: [],
    };
  }

  const root = parsed as { schemaVersion?: unknown; profiles?: unknown };
  if (root.schemaVersion !== 2 || !root.profiles || typeof root.profiles !== 'object') {
    return {
      status: 'invalid-config',
      configPath,
      error: 'unsupported config schema (expected schemaVersion 2)',
      profiles: [],
    };
  }

  const profiles: LarkBridgeProfileInfo[] = [];
  for (const [name, value] of Object.entries(root.profiles as Record<string, unknown>)) {
    if (!name.trim() || !value || typeof value !== 'object') continue;
    const profile = value as {
      agentKind?: unknown;
      workspaces?: { default?: unknown };
      codex?: { codexHome?: unknown; inheritCodexHome?: unknown };
    };
    if (profile.agentKind !== 'claude' && profile.agentKind !== 'codex') continue;
    const defaultWorkspace = typeof profile.workspaces?.default === 'string'
      && profile.workspaces.default.trim()
      ? profile.workspaces.default.trim()
      : undefined;
    profiles.push({
      name,
      agentKind: profile.agentKind,
      ...(defaultWorkspace ? { defaultWorkspace } : {}),
      ...(typeof profile.codex?.codexHome === 'string' && profile.codex.codexHome.trim()
        ? { codexHome: profile.codex.codexHome.trim() }
        : {}),
      inheritCodexHome: profile.codex?.inheritCodexHome !== false,
    });
  }
  profiles.sort((a, b) => a.name.localeCompare(b.name));
  return { status: 'ready', configPath, profiles };
}

/**
 * The env block the bridge injects when spawning an agent for this profile
 * (lark-coding-agent-bridge: src/agent/lark-channel-env.ts). Returns null when
 * the profile does not exist or its agentKind does not match, so callers fall
 * back to an unbound launch. Never sets CLAUDE_CONFIG_DIR; sets CODEX_HOME only
 * when the profile demands it (explicit codexHome or inheritCodexHome === false).
 */
export function buildLarkBridgeLaunchEnv(
  home: string,
  profileName: string,
  kind: LarkBridgeAgentKind,
): Record<string, string> | null {
  if (!profileName.trim()) return null;
  const state = readLarkBridgeState(home);
  if (state.status !== 'ready') return null;
  const profile = state.profiles.find((entry) => entry.name === profileName);
  if (!profile || profile.agentKind !== kind) return null;

  const profileDir = join(home, 'profiles', profileName);
  const env: Record<string, string> = {
    LARK_CHANNEL: '1',
    LARK_CHANNEL_PROFILE: profileName,
    LARK_CHANNEL_HOME: home,
    LARKSUITE_CLI_CONFIG_DIR: join(profileDir, 'lark-cli'),
  };
  const sourceConfigFile = join(profileDir, 'lark-cli-source', 'config.json');
  env.LARK_CHANNEL_CONFIG = existsSync(sourceConfigFile)
    ? sourceConfigFile
    : getLarkBridgeConfigPath(home);

  if (kind === 'codex') {
    if (profile.codexHome) {
      env.CODEX_HOME = profile.codexHome;
    } else if (!profile.inheritCodexHome) {
      env.CODEX_HOME = join(profileDir, 'codex-home');
    }
  }
  return env;
}

/**
 * Whether the profile's fallback workspace matches the vault. null = profile has
 * no default workspace (Feishu-side runs then fall back to the bridge's default
 * workspace dir, which always diverges from the vault).
 */
export function larkBridgeWorkspaceMatches(
  profileWorkspace: string | undefined,
  vaultPath: string,
): boolean | null {
  if (!profileWorkspace?.trim()) return null;
  return normalizeWorkspacePath(profileWorkspace) === normalizeWorkspacePath(vaultPath);
}

function normalizeWorkspacePath(value: string): string {
  let normalized = value.trim().replace(/[\\/]+$/, '');
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase().replace(/\//g, '\\');
  }
  return normalized;
}
