import { decodePiModelId, normalizePiThinkingLevel } from '../models';
import type { PiProviderSettings } from '../settings';
import type { PiProviderState } from '../types';
import { inferWslDistroFromWindowsPath } from './PiExecutionTargetResolver';
import type { PiExecutionTarget, PiWslLaunchSpec } from './piLaunchTypes';
import { createPiPathMapper } from './PiPathMapper';

export interface BuildPiLaunchSpecParams {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  envText?: string;
  model?: string | null;
  noSession?: boolean;
  noTools?: boolean;
  tools?: readonly string[];
  providerState?: PiProviderState | null;
  settings: PiProviderSettings;
  systemPrompt?: string;
  systemPromptFile?: string;
  thinkingLevel?: string | null;
}

export interface PiLaunchSpec {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  processKey: string;
  sessionTarget: string | null;
  wslLaunchSpec?: PiWslLaunchSpec;
}

const READONLY_TOOLS = 'read,grep,find,ls';

export function buildPiLaunchSpec(params: BuildPiLaunchSpecParams): PiLaunchSpec {
  const args = ['--mode', 'rpc'];
  let sessionFlagIndex: number | null = null;
  const sessionTarget = params.providerState?.sessionFile
    ?? params.providerState?.sessionId
    ?? null;
  const systemPrompt = params.systemPrompt?.trim();
  const isWsl = params.settings.installationMethod === 'wsl';

  // In WSL mode, use --append-system-prompt <file> to avoid bash interpreting
  // multi-line system prompt content with special characters as commands.
  if (systemPrompt) {
    if (isWsl && params.systemPromptFile) {
      args.push('--append-system-prompt', params.systemPromptFile);
    } else {
      args.push('--system-prompt', systemPrompt);
    }
  }

  if (params.noSession) {
    args.push('--no-session');
  } else if (sessionTarget) {
    sessionFlagIndex = args.length;
    args.push('--session', sessionTarget);
  }

  if (params.noTools) {
    args.push('--no-tools');
  } else if (params.tools) {
    args.push('--tools', params.tools.join(','));
  } else if (params.settings.toolMode === 'readonly') {
    args.push('--tools', READONLY_TOOLS);
  }

  const decodedModel = typeof params.model === 'string' ? decodePiModelId(params.model) : null;
  if (decodedModel) {
    args.push('--provider', decodedModel.provider, '--model', decodedModel.modelId);
  }

  const thinkingLevel = normalizePiThinkingLevel(params.thinkingLevel);
  if (thinkingLevel && thinkingLevel !== 'off') {
    args.push('--thinking', thinkingLevel);
  }

  const launchSpec: PiLaunchSpec = {
    args,
    command: params.command,
    cwd: params.cwd,
    env: params.env ?? process.env,
    processKey: JSON.stringify({
      args: withoutSessionTarget(args, sessionFlagIndex),
      command: params.command,
      cwd: params.cwd,
      envText: params.envText ?? params.settings.environmentVariables,
    }),
    sessionTarget: params.noSession ? null : sessionTarget,
  };

  // WSL mode: build WSL launch spec to wrap the pi args in wsl.exe bash -i
  if (isWsl) {
    launchSpec.wslLaunchSpec = buildPiWslLaunchSpec({
      command: params.command,
      cliArgs: args,
      hostVaultPath: params.cwd,
      env: params.env ?? process.env,
      wslDistroOverride: params.settings.wslDistroOverride,
    });
  }

  return launchSpec;
}

export interface BuildPiWslLaunchSpecOptions {
  command: string;
  cliArgs: string[];
  hostVaultPath: string;
  env: NodeJS.ProcessEnv;
  wslDistroOverride?: string;
}

export function buildPiWslLaunchSpec(
  options: BuildPiWslLaunchSpecOptions,
): PiWslLaunchSpec {
  const target: PiExecutionTarget = {
    method: 'wsl',
    platformFamily: 'unix',
    platformOs: 'linux',
    distroName: options.wslDistroOverride
      || inferWslDistroFromWindowsPath(options.hostVaultPath)
      || undefined,
  };
  const pathMapper = createPiPathMapper(target);
  const distro = target.distroName ?? 'Ubuntu';
  const targetCwd = pathMapper.toTargetPath(options.hostVaultPath) ?? '/';
  const targetCommand = pathMapper.toTargetPath(options.command) ?? options.command;

  // Convert Windows/UNC paths in cliArgs to WSL paths for --session and --append-system-prompt
  const mappedArgs = mapPiCliArgsToWsl(options.cliArgs, pathMapper);
  // Prepend the pi command itself so bash runs `pi --mode rpc ...` instead of
  // treating the first arg (e.g. --mode) as the command.
  const allArgs = [targetCommand, ...mappedArgs];
  const escapedArgs = allArgs.map(a => a.replace(/'/g, "'\\''"));
  const commandString = `'${escapedArgs.join("' '")}'`;

  const wslArgs = [
    '-d', distro,
    '--cd', targetCwd,
    '--',
    'bash', '-i', '-c', commandString,
  ];

  return {
    target,
    command: 'wsl.exe',
    args: wslArgs,
    spawnCwd: options.hostVaultPath,
    targetCwd,
    env: options.env as Record<string, string>,
    pathMapper,
  };
}

/**
 * Map CLI argument paths from Windows/UNC to WSL paths.
 * Handles --session, --append-system-prompt, and the command itself.
 */
function mapPiCliArgsToWsl(
  args: string[],
  pathMapper: ReturnType<typeof createPiPathMapper>,
): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--session' && i + 1 < args.length) {
      // Convert session file path from Windows/UNC to WSL path
      const mapped = pathMapper.toTargetPath(args[i + 1]) ?? args[i + 1];
      result.push(arg, mapped);
      i += 2;
    } else if (arg === '--append-system-prompt' && i + 1 < args.length) {
      // Convert system prompt temp file path to WSL path
      const mapped = pathMapper.toTargetPath(args[i + 1]) ?? args[i + 1];
      result.push(arg, mapped);
      i += 2;
    } else {
      result.push(arg);
      i += 1;
    }
  }
  return result;
}

function withoutSessionTarget(
  args: readonly string[],
  sessionFlagIndex: number | null,
): string[] {
  if (sessionFlagIndex === null) return [...args];
  return [
    ...args.slice(0, sessionFlagIndex),
    ...args.slice(sessionFlagIndex + 2),
  ];
}