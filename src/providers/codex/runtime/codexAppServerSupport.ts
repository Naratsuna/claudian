import { buildLarkBridgeLaunchEnv, resolveLarkChannelHome } from '../../../core/larkbridge/LarkBridgeConfig';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type {
  ProviderId,
  ProviderTransitionOwnerContext,
} from '../../../core/providers/types';
import { getEnhancedPath, parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import { getCodexProviderSettings } from '../settings';
import type { InitializeResult } from './codexAppServerTypes';
import { resolveCodexExecutionTargetAsync } from './CodexExecutionTargetResolver';
import { buildCodexLaunchSpec } from './CodexLaunchSpecBuilder';
import type { CodexLaunchSpec } from './codexLaunchTypes';
import type { CodexRPCTransport } from './CodexRPCTransport';

const CODEX_APP_SERVER_CLIENT_INFO = Object.freeze({
  name: 'claudian',
  version: '1.0.0',
});

export function getCodexAppServerWorkingDirectory(plugin: ProviderHost): string {
  return getVaultPath(plugin.app) ?? process.cwd();
}

export function buildCodexAppServerEnvironment(
  plugin: ProviderHost,
  providerId: ProviderId = 'codex',
): Record<string, string> {
  const customEnv = parseEnvironmentVariables(plugin.getActiveEnvironmentVariables(providerId));
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const enhancedPath = getEnhancedPath(customEnv.PATH);
  // Bridge env wins over custom env for its own keys (see buildLarkBridgeLaunchEnv);
  // in inherit mode no CODEX_HOME is set and a user-entered one stays as-is.
  const bridgeEnv = buildLarkBridgeLaunchEnv(
    resolveLarkChannelHome(),
    getCodexProviderSettings(plugin.settings).larkBridgeProfile,
    'codex',
  );

  return {
    ...baseEnv,
    ...customEnv,
    ...bridgeEnv,
    PATH: enhancedPath,
  };
}

export async function resolveCodexAppServerLaunchSpec(
  plugin: ProviderHost,
  providerId: ProviderId = 'codex',
  context?: ProviderTransitionOwnerContext,
): Promise<CodexLaunchSpec> {
  const hostVaultPath = getCodexAppServerWorkingDirectory(plugin);
  const executionTarget = await resolveCodexExecutionTargetAsync({
    settings: plugin.settings,
    hostVaultPath,
  });

  return buildCodexLaunchSpec({
    settings: plugin.settings,
    resolvedCliCommand: await plugin.getResolvedProviderCliPath(providerId, {
      ...context,
      executionTarget,
    }),
    hostVaultPath,
    env: buildCodexAppServerEnvironment(plugin, providerId),
    executionTarget,
  });
}

export async function initializeCodexAppServerTransport(
  transport: CodexRPCTransport,
): Promise<InitializeResult> {
  const result = await transport.request<InitializeResult>('initialize', {
    clientInfo: CODEX_APP_SERVER_CLIENT_INFO,
    capabilities: { experimentalApi: true },
  });

  transport.notify('initialized');
  return result;
}
