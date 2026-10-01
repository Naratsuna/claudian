import { Notice, setIcon, Setting } from 'obsidian';

import {
  type LarkBridgeProfileInfo,
  larkBridgeWorkspaceMatches,
  readLarkBridgeState,
} from '../../core/larkbridge/LarkBridgeConfig';
import type { ProviderHost } from '../../core/providers/ProviderHost';
import { t } from '../../i18n/i18n';
import { parseEnvironmentVariables } from '../../utils/env';
import { getVaultPath } from '../../utils/path';

export interface LarkBridgeSettingOptions {
  container: HTMLElement;
  plugin: ProviderHost;
  providerId: 'claude' | 'codex';
  /** False for codex under WSL — host env cannot cross the WSL boundary. */
  bindingSupported: boolean;
  getBoundProfile: () => string;
  onBind: (profile: string) => Promise<void>;
  /** Custom env text for conflict checks (codex CODEX_HOME). */
  getCustomEnvText: () => string;
}

export interface LarkBridgeSettingControl {
  refresh: () => void;
  setBindingSupported: (supported: boolean) => void;
}

const VALIDATION_CLASSES = ['claudian-setting-validation'].join(' ');
const WARNING_CLASSES = ['claudian-setting-validation', 'claudian-setting-validation-warning'].join(' ');

/**
 * "Lark Channel Bridge" settings section: bind this provider to a
 * lark-channel-bridge profile so its agents share the bridge's identity,
 * memory homes and lark-cli (Feishu) access. Read-only towards the bridge —
 * profile problems are reported as guidance, never rewritten from here.
 */
export function renderLarkBridgeSetting(options: LarkBridgeSettingOptions): LarkBridgeSettingControl {
  let bindingSupported = options.bindingSupported;

  new Setting(options.container)
    .setName(t('settings.larkBridge.heading'))
    .setHeading()
    .addExtraButton((button) => {
      button
        .setIcon('refresh-cw')
        .setTooltip(t('settings.larkBridge.refresh'))
        .onClick(() => render());
    });

  const statusEl = options.container.createDiv();

  function render(): void {
    statusEl.replaceChildren();

    if (!bindingSupported) {
      addStatus(t('settings.larkBridge.wsl.unsupported'), WARNING_CLASSES);
      return;
    }

    const state = readLarkBridgeState();
    if (state.status === 'not-installed') {
      addStatus(t('settings.larkBridge.notInstalled.desc', { configPath: state.configPath }), WARNING_CLASSES);
      return;
    }
    if (state.status === 'invalid-config') {
      addStatus(t('settings.larkBridge.invalidConfig.desc', {
        configPath: state.configPath,
        error: state.error ?? '',
      }), WARNING_CLASSES);
      return;
    }

    const profiles = state.profiles.filter((profile) => profile.agentKind === options.providerId);
    if (profiles.length === 0) {
      addStatus(t('settings.larkBridge.noProfiles.desc', { kind: options.providerId }), WARNING_CLASSES);
      return;
    }

    const bound = options.getBoundProfile();
    const boundProfile = profiles.find((profile) => profile.name === bound);
    if (bound && !boundProfile) {
      addStatus(t('settings.larkBridge.bindingMissing', { name: bound }), WARNING_CLASSES);
    }

    // The row is rebuilt per render so dropdown options track the bridge config.
    new Setting(statusEl)
      .setName(t('settings.larkBridge.name'))
      .setDesc(t('settings.larkBridge.desc'))
      .addDropdown((dropdown) => {
        for (const profile of profiles) {
          dropdown.addOption(profile.name, profile.name);
        }
        dropdown.addOption('', t('settings.larkBridge.unbound'));
        dropdown.setValue(boundProfile ? bound : '');
        dropdown.onChange(async (value) => {
          await options.onBind(value);
          render();
        });
      });

    if (boundProfile) {
      renderWorkspaceStatus(boundProfile);
      if (options.providerId === 'codex') renderCodexHomeConflict(boundProfile);
    }
  }

  function renderWorkspaceStatus(profile: LarkBridgeProfileInfo): void {
    const vaultPath = getVaultPath(options.plugin.app);
    if (!vaultPath) return;
    const matches = larkBridgeWorkspaceMatches(profile.defaultWorkspace, vaultPath);
    if (matches === true) {
      addStatus(t('settings.larkBridge.workspace.label', { path: profile.defaultWorkspace ?? '' }), VALIDATION_CLASSES);
      return;
    }
    const text = matches === null
      ? t('settings.larkBridge.workspace.unset')
      : t('settings.larkBridge.workspace.mismatch', {
        workspace: profile.defaultWorkspace ?? '',
        vault: vaultPath,
      });
    renderCdHint(text, vaultPath);
  }

  /** Mismatch/unset hint plus a one-click copy of the `/cd <vault>` fix command. */
  function renderCdHint(text: string, vaultPath: string): void {
    const row = statusEl.createDiv({ cls: `claudian-lark-bridge-cd-row ${WARNING_CLASSES}` });
    row.createSpan({ text });
    const copyButton = row.createEl('button', {
      cls: 'claudian-settings-action-btn',
      attr: { type: 'button', 'aria-label': t('settings.larkBridge.copyCd', { vault: vaultPath }) },
    });
    setIcon(copyButton, 'copy');
    copyButton.addEventListener('click', () => {
      void (async () => {
        try {
          await navigator.clipboard.writeText(`/cd ${vaultPath}`);
          new Notice(t('settings.larkBridge.copied', { vault: vaultPath }));
        } catch {
          // Clipboard can be blocked; surfacing the command is the fallback.
          new Notice(`/cd ${vaultPath}`);
        }
      })();
    });
  }

  function renderCodexHomeConflict(profile: LarkBridgeProfileInfo): void {
    if (profile.codexHome || !profile.inheritCodexHome) return;
    const customEnv = parseEnvironmentVariables(options.getCustomEnvText());
    if (!customEnv.CODEX_HOME) return;
    addStatus(t('settings.larkBridge.codexHome.conflict'), WARNING_CLASSES);
  }

  function addStatus(text: string, classes: string): void {
    statusEl.createDiv({ text, cls: classes });
  }

  render();
  return {
    refresh: render,
    setBindingSupported: (supported: boolean) => {
      bindingSupported = supported;
      render();
    },
  };
}
