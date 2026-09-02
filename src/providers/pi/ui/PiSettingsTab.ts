import * as fs from 'node:fs';

import { Notice, Setting } from 'obsidian';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type {
  ProviderSettingsTabRenderer,
  ProviderSettingsTabRendererContext,
} from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import { renderEnvironmentSettingsSection } from '../../../shared/settings/EnvironmentSettingsSection';
import { renderHostnameCliPathSetting } from '../../../shared/settings/HostnameCliPathSetting';
import { renderProviderEnablementSetting } from '../../../shared/settings/ProviderEnablementSetting';
import {
  renderLastEnabledProviderWarning,
  renderProviderModelEnablementWarning,
} from '../../../shared/settings/ProviderModelEnablementWarning';
import {
  type ProviderModelPickerModel,
  type ProviderModelPickerState,
  renderProviderModelPicker,
} from '../../../shared/settings/ProviderModelPicker';
import { getHostnameKey } from '../../../utils/env';
import { normalizeConfiguredCliPath } from '../../../utils/path';
import { maybeGetPiWorkspaceServices } from '../app/PiWorkspaceServices';
import { sameDiscoveredModels, sameStringList } from '../internal/compareCollections';
import { decodePiModelId, type PiDiscoveredModel } from '../models';
import { PiModelDiscoveryService } from '../runtime/PiModelDiscoveryService';
import {
  getPiProviderSettings,
  normalizePiVisibleModels,
  updatePiProviderSettings,
} from '../settings';

export const piSettingsTabRenderer: ProviderSettingsTabRenderer = {
  render(container, context) {
    const settingsBag = context.plugin.settings as unknown as Record<string, unknown>;
    const hostnameKey = getHostnameKey();
    const workspace = maybeGetPiWorkspaceServices();

    new Setting(container).setName('Setup').setHeading();

    renderProviderEnablementSetting({
      container,
      description: t('settings.providerEnablement.desc', { provider: 'Pi' }),
      getValue: () => getPiProviderSettings(settingsBag).enabled,
      name: t('settings.providerEnablement.name', { provider: 'Pi' }),
      onChange: async (value) => {
        if (!ProviderSettingsCoordinator.canApplyProviderEnablement(
          settingsBag,
          'pi',
          value,
        )) {
          lastProviderWarning.showFor();
          return;
        }

        let accepted = true;
        await context.plugin.runProviderExecutionTransition(['pi'], async () => {
          await context.plugin.mutateSettings((settings) => {
            accepted = ProviderSettingsCoordinator.applyProviderEnablement(
              settings,
              'pi',
              value,
            );
          });
        });
        if (accepted) {
          lastProviderWarning.hide();
        } else {
          lastProviderWarning.showFor();
        }
        modelWarning.context.notifyProviderModelOptionsChanged('pi');
      },
    });

    const lastProviderWarning = renderLastEnabledProviderWarning(container);

    const modelWarning = renderProviderModelEnablementWarning(container, context, {
      getHasEnabledModels: () => getPiProviderSettings(settingsBag).visibleModels.length > 0,
      getIsEnabled: () => getPiProviderSettings(settingsBag).enabled,
      providerId: 'pi',
      providerName: 'Pi',
    });

    const isWindowsHost = process.platform === 'win32';
    let installationMethod = getPiProviderSettings(settingsBag).installationMethod;
    let wslDistroInputEl: HTMLInputElement | null = null;
    let wslDistroSettingEl: HTMLElement | null = null;
    let wslHomePathInputEl: HTMLInputElement | null = null;
    let wslHomePathSettingEl: HTMLElement | null = null;

    const refreshInstallationMethodUI = (): void => {
      const isWsl = installationMethod === 'wsl';
      if (wslDistroInputEl) {
        wslDistroInputEl.disabled = !isWsl;
      }
      if (wslDistroSettingEl) {
        wslDistroSettingEl.toggleClass('claudian-hidden', !isWsl);
      }
      if (wslHomePathInputEl) {
        wslHomePathInputEl.disabled = !isWsl;
      }
      if (wslHomePathSettingEl) {
        wslHomePathSettingEl.toggleClass('claudian-hidden', !isWsl);
      }
    };

    if (isWindowsHost) {
      new Setting(container)
        .setName('Installation method')
        .setDesc('How Claudian should launch Pi on Windows. Native Windows uses a Windows executable path. WSL launches the Linux CLI inside a selected distro.')
        .addDropdown((dropdown) => {
          dropdown
            .addOption('native-windows', 'Native Windows')
            .addOption('wsl', 'WSL')
            .setValue(installationMethod)
            .onChange(async (value) => {
              installationMethod = value === 'wsl' ? 'wsl' : 'native-windows';
              await context.plugin.applyProviderRuntimeSettings(
                ['pi'],
                (settings) => {
                  updatePiProviderSettings(settings, { installationMethod });
                },
                () => workspace?.cliResolver?.reset(),
              );
              refreshInstallationMethodUI();
              await refreshPiModelCatalog();
            });
        });

      const wslDistroSetting = new Setting(container)
        .setName('WSL distro override')
        .setDesc('Optional advanced override. Leave empty to infer the distro from a workspace path when possible, otherwise use the default WSL distro.');

      wslDistroSettingEl = wslDistroSetting.settingEl;

      wslDistroSetting.addText((text) => {
        text
          .setPlaceholder('Ubuntu')
          .setValue(getPiProviderSettings(settingsBag).wslDistroOverride)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updatePiProviderSettings(settings, { wslDistroOverride: value });
            });
          });

        text.inputEl.addClass('claudian-settings-cli-path-input');
        text.inputEl.disabled = installationMethod !== 'wsl';
        wslDistroInputEl = text.inputEl;
      });

      const wslHomePathSetting = new Setting(container)
        .setName('WSL home path')
        .setDesc('The home directory path in WSL where Pi stores session files. E.g., /home/username. Required for history loading when the Windows username differs from the WSL username.');

      wslHomePathSettingEl = wslHomePathSetting.settingEl;

      wslHomePathSetting.addText((text) => {
        text
          .setPlaceholder('/home/username')
          .setValue(getPiProviderSettings(settingsBag).wslHomePath)
          .onChange(async (value) => {
            await context.plugin.mutateSettings((settings) => {
              updatePiProviderSettings(settings, { wslHomePath: value });
            });
          });

        text.inputEl.addClass('claudian-settings-cli-path-input');
        text.inputEl.disabled = installationMethod !== 'wsl';
        wslHomePathInputEl = text.inputEl;
      });
    }

    const isWslMode = (): boolean => isWindowsHost && installationMethod === 'wsl';

    renderHostnameCliPathSetting({
      container,
      description: isWindowsHost
        ? isWslMode()
          ? 'Linux-side Pi command or absolute path to run inside WSL. Leave empty for PATH lookup inside the selected distro.'
          : 'Optional absolute path to the Pi CLI for this computer. Leave empty to use `pi` from PATH.'
        : 'Optional absolute path to the Pi CLI for this computer. Leave empty to use `pi` from PATH.',
      getValue: () => getPiProviderSettings(settingsBag).cliPathsByHost[hostnameKey] || '',
      name: 'CLI path',
      onChange: async (value) => {
        const cliPathsByHost = {
          ...getPiProviderSettings(settingsBag).cliPathsByHost,
        };
        if (value) {
          cliPathsByHost[hostnameKey] = value;
        } else {
          delete cliPathsByHost[hostnameKey];
        }

        await context.plugin.applyProviderRuntimeSettings(
          ['pi'],
          (settings) => {
            updatePiProviderSettings(settings, {
              cliPathsByHost,
              discoveredModels: [],
            });
          },
          () => workspace?.cliResolver?.reset(),
        );
        context.notifyProviderModelOptionsChanged('pi');
      },
      placeholder: isWindowsHost
        ? isWslMode()
          ? 'pi'
          : 'C:\\Users\\you\\AppData\\Roaming\\npm\\pi.cmd'
        : '/usr/local/bin/pi',
      validate: (value) => validateCliPath(value, isWslMode()),
    });

    async function refreshPiModelCatalog(): Promise<void> {
      try {
        const result = await new PiModelDiscoveryService(context.plugin).discoverModels();
        if (result.kind === 'skipped') {
          return;
        }
        if (result.diagnostics) {
          new Notice(`Pi discovery failed: ${result.diagnostics}`);
          return;
        }
        const current = getPiProviderSettings(settingsBag);
        const normalizedVisibleModels = normalizePiVisibleModels(current.visibleModels, result.models);
        await context.plugin.mutateSettings((settings) => {
          updatePiProviderSettings(settings, {
            discoveredModels: result.models,
            visibleModels: normalizedVisibleModels,
          });
        });
        context.notifyProviderModelOptionsChanged('pi');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`Pi discovery failed: ${message}`);
      }
    }

    refreshInstallationMethodUI();

    new Setting(container).setName('Models').setHeading();
    renderPiModelPicker(container, modelWarning.context, settingsBag);

    new Setting(container).setName(t('settings.agentSkills.sectionTitle')).setHeading();
    context.renderAgentSkillSettings(container, 'pi');

    new Setting(container).setName('Commands').setHeading();
    context.renderHiddenProviderCommandSetting(container, 'pi', {
      name: 'Hidden Pi commands and skills',
      desc: 'Hide runtime commands and skills advertised by Pi from the command dropdown. Enter exact names without the leading slash, one per line.',
      placeholder: 'skill:review\ncompact',
    });

    renderEnvironmentSettingsSection({
      container,
      desc: 'Environment variables passed only to Pi.',
      heading: 'Environment',
      name: 'Pi environment variables',
      placeholder: 'PI_CODING_AGENT_SESSION_DIR=/path/to/sessions',
      plugin: context.plugin,
      scope: 'provider:pi',
    });
  },
};

function renderPiModelPicker(
  container: HTMLElement,
  context: ProviderSettingsTabRendererContext,
  settingsBag: Record<string, unknown>,
): void {
  const getState = (): ProviderModelPickerState => {
    const current = getPiProviderSettings(settingsBag);
    return {
      aliases: current.modelAliases,
      discoveredCount: current.discoveredModels.length,
      models: buildPiPickerModels(current.discoveredModels, current.visibleModels),
      selectedIds: current.visibleModels,
    };
  };

  renderProviderModelPicker({
    container,
    emptyCatalogText: 'No Pi models discovered yet. Click Discover to load models from Pi.',
    failedCatalogText: 'Could not load the Pi model catalog. Check the CLI path and login state, then try again.',
    getState,
    async loadCatalog() {
      const result = await new PiModelDiscoveryService(context.plugin).discoverModels();
      if (result.kind === 'skipped') {
        return getPiProviderSettings(settingsBag).discoveredModels.length > 0 ? 'loaded' : 'empty';
      }
      if (result.diagnostics) {
        new Notice(`Pi discovery failed: ${result.diagnostics}`);
        return 'failed';
      }

      const current = getPiProviderSettings(settingsBag);
      const normalizedVisibleModels = normalizePiVisibleModels(current.visibleModels, result.models);
      const catalogChanged = !sameDiscoveredModels(current.discoveredModels, result.models);
      const visibilityChanged = !sameStringList(current.visibleModels, normalizedVisibleModels);
      if (catalogChanged || visibilityChanged) {
        await context.plugin.mutateSettings((settings) => {
          updatePiProviderSettings(settings, {
            discoveredModels: result.models,
            visibleModels: normalizedVisibleModels,
          });
        });
        context.notifyProviderModelOptionsChanged('pi');
      }
      return result.models.length > 0 ? 'loaded' : 'empty';
    },
    loadingCatalogText: 'Loading Pi model catalog...',
    modifier: 'pi',
    async onAliasesChange(modelAliases) {
      await context.plugin.mutateSettings((settings) => {
        updatePiProviderSettings(settings, { modelAliases });
      });
      context.notifyProviderModelOptionsChanged('pi');
    },
    async onSelectedIdsChange(visibleModels) {
      const current = getPiProviderSettings(settingsBag);
      const normalized = normalizePiVisibleModels(visibleModels, current.discoveredModels);
      if (sameStringList(current.visibleModels, normalized)) {
        return;
      }

      await context.plugin.mutateSettings((settings) => {
        updatePiProviderSettings(settings, { visibleModels: normalized });
      });
      context.notifyProviderModelOptionsChanged('pi');
    },
    providerName: 'Pi',
  });
}

function validateCliPath(value: string, isWsl = false): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (isWsl) {
    // WSL mode: accept Linux paths or plain command names; reject Windows paths
    if (/^[A-Za-z]:/.test(trimmed)) {
      return 'WSL mode expects a Linux command or Linux absolute path, not a Windows executable path.';
    }
    return null;
  }

  const expandedPath = normalizeConfiguredCliPath(trimmed);
  if (!fs.existsSync(expandedPath)) {
    return 'Path does not exist';
  }

  if (!fs.statSync(expandedPath).isFile()) {
    return 'Path must point to a file';
  }

  return null;
}

function buildPiPickerModels(
  discoveredModels: PiDiscoveredModel[],
  visibleModels: string[],
): ProviderModelPickerModel[] {
  const models: ProviderModelPickerModel[] = [];
  const discoveredIds = new Set<string>();

  for (const model of discoveredModels) {
    discoveredIds.add(model.encodedId);
    models.push({
      description: buildPiModelDescription(model),
      id: model.encodedId,
      isAvailable: true,
      name: model.label || model.id,
      providerKey: model.provider.toLowerCase(),
      providerLabel: formatProviderLabel(model.provider),
    });
  }

  for (const encodedId of visibleModels) {
    if (discoveredIds.has(encodedId)) {
      continue;
    }

    const decoded = decodePiModelId(encodedId);
    const provider = decoded?.provider ?? 'pi';
    models.push({
      description: 'Configured model',
      id: encodedId,
      isAvailable: false,
      name: decoded?.modelId ?? encodedId,
      providerKey: provider.toLowerCase(),
      providerLabel: formatProviderLabel(provider),
      unavailableMessage: 'Not currently reported by Pi',
    });
  }

  return models.sort((left, right) => {
    const providerCmp = (left.providerLabel ?? '').localeCompare(right.providerLabel ?? '');
    if (providerCmp !== 0) {
      return providerCmp;
    }
    return left.name.localeCompare(right.name);
  });
}

function buildPiModelDescription(model: PiDiscoveredModel): string {
  const details: string[] = [];
  if (model.api) {
    details.push(`API: ${model.api}`);
  }
  if (model.contextWindow) {
    details.push(`${model.contextWindow.toLocaleString()} context`);
  }
  if (model.maxTokens) {
    details.push(`${model.maxTokens.toLocaleString()} output`);
  }
  if (model.input.includes('image')) {
    details.push('image input');
  }
  details.push(model.reasoning
    ? `thinking: ${model.thinkingLevels.join(', ')}`
    : 'thinking: off');

  return details.join(' | ');
}

function formatProviderLabel(provider: string): string {
  const normalized = provider.trim();
  const knownProviders: Record<string, string> = {
    anthropic: 'Anthropic',
    deepseek: 'DeepSeek',
    google: 'Google',
    openai: 'OpenAI',
    xai: 'xAI',
  };
  const known = knownProviders[normalized.toLowerCase()];
  if (known) {
    return known;
  }

  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Pi';
}
