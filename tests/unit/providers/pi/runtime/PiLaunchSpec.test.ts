import { buildPiLaunchSpec } from '@/providers/pi/runtime/PiLaunchSpec';
import type { PiProviderSettings } from '@/providers/pi/settings';

const baseSettings: PiProviderSettings = {
  cliPath: '',
  cliPathsByHost: {},
  discoveredModels: [],
  enabled: true,
  environmentHash: '',
  environmentVariables: '',
  modelAliases: {},
  preferredThinkingByModel: {},
  toolMode: 'all',
  visibleModels: [],
  installationMethod: 'native-windows',
  installationMethodsByHost: {},
  wslDistroOverride: '',
  wslDistroOverridesByHost: {},
  wslHomePath: '',
};

describe('PiLaunchSpec', () => {
  it('builds main launch args with replacement system prompt and model flags', () => {
    expect(buildPiLaunchSpec({
      command: '/bin/pi',
      cwd: '/vault',
      model: 'pi:anthropic/claude/sonnet',
      providerState: { sessionFile: '/tmp/session.jsonl' },
      settings: baseSettings,
      systemPrompt: 'System prompt',
      thinkingLevel: 'high',
    }).args).toEqual([
      '--mode',
      'rpc',
      '--system-prompt',
      'System prompt',
      '--session',
      '/tmp/session.jsonl',
      '--provider',
      'anthropic',
      '--model',
      'claude/sonnet',
      '--thinking',
      'high',
    ]);
  });

  it('adds no-session and read-only tools when requested', () => {
    expect(buildPiLaunchSpec({
      command: 'pi',
      cwd: '/vault',
      noSession: true,
      settings: {
        ...baseSettings,
        toolMode: 'readonly',
      },
    }).args).toEqual([
      '--mode',
      'rpc',
      '--no-session',
      '--tools',
      'read,grep,find,ls',
    ]);
  });

  it('does not resume from detached previous sessions', () => {
    expect(buildPiLaunchSpec({
      command: 'pi',
      cwd: '/vault',
      providerState: {
        previousSessions: [{
          leafEntryId: 'assistant-1',
          sessionFile: '/tmp/previous.jsonl',
          sessionId: 'previous-session',
        }],
      },
      settings: baseSettings,
    }).args).toEqual(['--mode', 'rpc']);
  });

  it('passes max thinking through to Pi', () => {
    expect(buildPiLaunchSpec({
      command: 'pi',
      cwd: '/vault',
      noSession: true,
      settings: baseSettings,
      thinkingLevel: 'max',
    }).args).toEqual([
      '--mode',
      'rpc',
      '--no-session',
      '--thinking',
      'max',
    ]);
  });

  it('uses no-tools for passive auxiliary launches', () => {
    expect(buildPiLaunchSpec({
      command: 'pi',
      cwd: '/vault',
      noSession: true,
      noTools: true,
      settings: baseSettings,
    }).args).toEqual([
      '--mode',
      'rpc',
      '--no-session',
      '--no-tools',
    ]);
  });

  it('includes full runtime environment text in the process key', () => {
    const first = buildPiLaunchSpec({
      command: 'pi',
      cwd: '/vault',
      envText: 'PATH=/first',
      settings: baseSettings,
    });
    const second = buildPiLaunchSpec({
      command: 'pi',
      cwd: '/vault',
      envText: 'PATH=/second',
      settings: baseSettings,
    });

    expect(first.processKey).not.toBe(second.processKey);
  });

  it('keeps session identity separate from process compatibility', () => {
    const first = buildPiLaunchSpec({
      command: 'pi',
      cwd: '/vault',
      providerState: { sessionFile: '/tmp/first.jsonl' },
      settings: baseSettings,
      systemPrompt: '--session',
    });
    const second = buildPiLaunchSpec({
      command: 'pi',
      cwd: '/vault',
      providerState: { sessionFile: '/tmp/second.jsonl' },
      settings: baseSettings,
      systemPrompt: '--session',
    });

    expect(first.processKey).toBe(second.processKey);
    expect(JSON.parse(first.processKey).args).toEqual([
      '--mode',
      'rpc',
      '--system-prompt',
      '--session',
    ]);
    expect(first.sessionTarget).toBe('/tmp/first.jsonl');
    expect(second.sessionTarget).toBe('/tmp/second.jsonl');
  });
});

describe('PiLaunchSpec WSL', () => {
  const wslSettings: PiProviderSettings = {
    ...baseSettings,
    installationMethod: 'wsl',
    wslDistroOverride: 'Ubuntu-24.04',
    wslHomePath: '/home/hebo',
  };

  it('builds a wsl.exe launch spec wrapping the pi args with bash -i', () => {
    const spec = buildPiLaunchSpec({
      command: 'pi',
      cwd: 'E:\\work-journal',
      noSession: true,
      settings: wslSettings,
    });

    expect(spec.wslLaunchSpec).toBeDefined();
    expect(spec.wslLaunchSpec!.command).toBe('wsl.exe');
    expect(spec.wslLaunchSpec!.args[0]).toBe('-d');
    expect(spec.wslLaunchSpec!.args[1]).toBe('Ubuntu-24.04');
    // --cd maps the Windows drive to /mnt/e
    expect(spec.wslLaunchSpec!.args).toContain('--cd');
    expect(spec.wslLaunchSpec!.args).toContain('/mnt/e/work-journal');
    // bash -i interactive shell loads fnm/nvm
    expect(spec.wslLaunchSpec!.args).toContain('bash');
    expect(spec.wslLaunchSpec!.args).toContain('-i');
  });

  it('uses --append-system-prompt with a temp file instead of --system-prompt in WSL mode', () => {
    const spec = buildPiLaunchSpec({
      command: 'pi',
      cwd: 'E:\\work-journal',
      noSession: true,
      settings: wslSettings,
      systemPrompt: 'Multi-line\nsystem prompt',
      systemPromptFile: 'E:\\work-journal\\.claudian\\tmp\\pi-system-prompt.md',
    });

    expect(spec.args).toContain('--append-system-prompt');
    expect(spec.args).toContain('E:\\work-journal\\.claudian\\tmp\\pi-system-prompt.md');
    expect(spec.args).not.toContain('--system-prompt');
  });

  it('maps the session file from a Windows path to a WSL path in the wrapped command', () => {
    const spec = buildPiLaunchSpec({
      command: 'pi',
      cwd: 'E:\\work-journal',
      providerState: { sessionFile: 'E:\\work-journal\\.pi\\agent\\sessions\\abc\\123.jsonl' },
      settings: wslSettings,
    });

    const commandString = spec.wslLaunchSpec!.args[spec.wslLaunchSpec!.args.length - 1];
    expect(commandString).toContain('/mnt/e/work-journal/.pi/agent/sessions/abc/123.jsonl');
  });

  it('falls back to native mode when installationMethod is native-windows', () => {
    const spec = buildPiLaunchSpec({
      command: 'pi',
      cwd: 'E:\\work-journal',
      noSession: true,
      settings: baseSettings,
    });

    expect(spec.wslLaunchSpec).toBeUndefined();
    expect(spec.command).toBe('pi');
  });
});
