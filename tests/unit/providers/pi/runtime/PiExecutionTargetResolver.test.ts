import {
  parseDefaultWslDistroListOutput,
  resolvePiExecutionTarget,
} from '@/providers/pi/runtime/PiExecutionTargetResolver';

describe('PiExecutionTargetResolver', () => {
  it('infers the WSL distro from a \\\\wsl$ workspace path', () => {
    const target = resolvePiExecutionTarget({
      settings: {
        providerConfigs: {
          pi: {
            installationMethod: 'wsl',
          },
        },
      },
      hostPlatform: 'win32',
      hostVaultPath: '\\\\wsl$\\Ubuntu\\home\\user\\repo',
    });

    expect(target).toMatchObject({
      method: 'wsl',
      platformFamily: 'unix',
      platformOs: 'linux',
      distroName: 'Ubuntu',
    });
  });

  it('uses the explicit WSL distro override when set', () => {
    const target = resolvePiExecutionTarget({
      settings: {
        providerConfigs: {
          pi: {
            installationMethod: 'wsl',
            wslDistroOverride: 'Debian',
          },
        },
      },
      hostPlatform: 'win32',
      hostVaultPath: 'C:\\repo',
    });

    expect(target).toMatchObject({
      method: 'wsl',
      distroName: 'Debian',
    });
  });

  it('falls back to the default WSL distro resolver', () => {
    const target = resolvePiExecutionTarget({
      settings: {
        providerConfigs: {
          pi: {
            installationMethod: 'wsl',
          },
        },
      },
      hostPlatform: 'win32',
      hostVaultPath: 'C:\\repo',
      resolveDefaultWslDistro: () => 'Ubuntu',
    });

    expect(target).toMatchObject({
      method: 'wsl',
      distroName: 'Ubuntu',
    });
  });

  it('preserves native host execution on non-Windows hosts', () => {
    const target = resolvePiExecutionTarget({
      settings: {
        providerConfigs: {
          pi: {
            installationMethod: 'wsl',
          },
        },
      },
      hostPlatform: 'darwin',
      hostVaultPath: '/Users/example/repo',
    });

    expect(target).toMatchObject({
      method: 'host-native',
      platformFamily: 'unix',
      platformOs: 'macos',
    });
  });

  it('returns native-windows when installation method is not WSL on Windows', () => {
    const target = resolvePiExecutionTarget({
      settings: {
        providerConfigs: {
          pi: {
            installationMethod: 'native-windows',
          },
        },
      },
      hostPlatform: 'win32',
      hostVaultPath: 'C:\\repo',
    });

    expect(target).toMatchObject({
      method: 'native-windows',
      platformFamily: 'windows',
      platformOs: 'windows',
    });
  });

  it('parses default WSL distro from wsl --list output with UTF-16 BOM', () => {
    const output = '\uFEFF' + [
      '  NAME                   STATE           VERSION',
      '* Ubuntu-24.04           Running         2',
      '  Debian                 Stopped         2',
    ].join('\r\n');

    expect(parseDefaultWslDistroListOutput(output)).toBe('Ubuntu-24.04');
  });

  it('parses default WSL distro from wsl --list output without BOM', () => {
    const output = [
      '  NAME                   STATE           VERSION',
      '* Debian                 Running         2',
      '  Ubuntu                 Stopped         2',
    ].join('\n');

    expect(parseDefaultWslDistroListOutput(output)).toBe('Debian');
  });
});