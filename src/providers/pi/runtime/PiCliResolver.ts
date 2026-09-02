import { CachedProviderCliResolver } from '../../../core/providers/cli/CachedProviderCliResolver';
import { getRuntimeEnvironmentText } from '../../../core/providers/providerEnvironment';
import { getPiProviderSettings } from '../settings';

export class PiCliResolver {
  private readonly resolver = new CachedProviderCliResolver({
    binaryName: 'pi',
    getSettingsProjection: (settings) => {
      const providerSettings = getPiProviderSettings(settings);
      return {
        cliPathsByHost: providerSettings.cliPathsByHost,
        environmentText: getRuntimeEnvironmentText(settings, 'pi'),
        legacyCliPath: providerSettings.cliPath,
        resolutionInputs: {
          installationMethod: providerSettings.installationMethod,
        },
      };
    },
    providerId: 'pi',
    resolve: (context, resolveDefault) => {
      const isWsl = context.resolutionInputs?.installationMethod === 'wsl';
      if (isWsl) {
        // In WSL mode, prefer the bare command name so bash -i can resolve it
        // via fnm/nvm PATH. Only use explicit paths if the user configured them.
        const explicitPath = resolveWslCliPath(context.hostnamePath)
          ?? resolveWslCliPath(context.legacyCliPath);
        if (explicitPath) {
          return explicitPath;
        }
        return 'pi';
      }
      return resolveDefault();
    },
  });

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    return this.resolver.resolveFromSettings(settings);
  }

  resolve(
    hostnamePaths: Record<string, string> | undefined,
    legacyPath: string,
    envText = '',
    options: { installationMethod?: string } = {},
  ): string | null {
    return this.resolver.resolve({
      cliPathsByHost: hostnamePaths,
      environmentText: envText,
      legacyCliPath: legacyPath,
      resolutionInputs: options.installationMethod
        ? { installationMethod: options.installationMethod }
        : undefined,
    });
  }

  reset(): void {
    this.resolver.reset();
  }
}

function resolveWslCliPath(cliPath: string): string | null {
  const trimmed = cliPath.trim();
  if (!trimmed) {
    return null;
  }

  // WSL mode: Linux absolute paths or plain command names are valid.
  // Windows paths (C:\, \\server) are rejected so bash -i can resolve the command.
  if (trimmed.startsWith('/')) {
    return trimmed;
  }
  if (!trimmed.includes('/') && !trimmed.includes('\\')) {
    return trimmed;
  }
  return null;
}