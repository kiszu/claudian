import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ProviderHistoryPathContext } from '../../../core/providers/types';
import { isPathWithinRoot } from '../../../core/storage/pathContainment';
import { inferWslDistroFromWindowsPath } from '../runtime/PiExecutionTargetResolver';
import { getPiProviderSettings } from '../settings';
import { findPiSessionFile, findPiSessionFileInRoot } from './PiHistoryStore';

function getConfiguredSessionDir(context: ProviderHistoryPathContext): string | null {
  const configured = context.environment.PI_CODING_AGENT_SESSION_DIR?.trim();
  return configured && path.isAbsolute(configured) ? configured : null;
}

/**
 * Build the UNC \\wsl$\<distro> root for the WSL user home, used to read Pi
 * session files that live inside the WSL filesystem (~/.pi/agent/sessions).
 * Only applicable when running on Windows with the Pi installation method set
 * to WSL and the Windows username differs from (or matches) the WSL username.
 */
function buildWslSessionsUncRoot(
  vaultPath: string | null,
  context: ProviderHistoryPathContext,
): string | null {
  if ((context.hostPlatform ?? process.platform) !== 'win32' || !context.settings) {
    return null;
  }
  const piSettings = getPiProviderSettings(context.settings);
  if (piSettings.installationMethod !== 'wsl') {
    return null;
  }

  const distroName = piSettings.wslDistroOverride
    || inferWslDistroFromWindowsPath(context.vaultPath ?? vaultPath)
    || '';
  if (!distroName) {
    return null;
  }

  // Resolve the WSL home. Prefer an explicit setting; otherwise infer from the
  // Windows user profile name (the common default for WSL installs).
  let wslHome = piSettings.wslHomePath.trim();
  if (!wslHome) {
    const windowsUser = context.environment.USERPROFILE
      ? path.win32.basename(context.environment.USERPROFILE.trim())
      : '';
    if (windowsUser) {
      wslHome = `/home/${windowsUser}`;
    }
  }
  if (!wslHome || !wslHome.startsWith('/')) {
    return null;
  }

  const relative = wslHome.replace(/^\//, '').replace(/\//g, '\\');
  return `\\\\wsl$\\${distroName}\\${relative}\\.pi\\agent\\sessions`;
}

function getTrustedRoots(
  vaultPath: string | null,
  context: ProviderHistoryPathContext,
): string[] {
  const roots: string[] = [];
  const configuredSessionDir = getConfiguredSessionDir(context);
  if (configuredSessionDir) {
    roots.push(configuredSessionDir);
  }

  const configuredAgentDir = context.environment.PI_CODING_AGENT_DIR?.trim();
  if (configuredAgentDir && path.isAbsolute(configuredAgentDir)) {
    roots.push(path.join(configuredAgentDir, 'sessions'));
  }
  if (vaultPath) {
    const vaultSessionRoot = path.join(vaultPath, '.pi', 'agent', 'sessions');
    if (isPathWithinRoot(vaultSessionRoot, vaultPath)) {
      roots.push(vaultSessionRoot);
    }
  }
  const home = context.environment.HOME?.trim()
    || context.environment.USERPROFILE?.trim()
    || os.homedir();
  roots.push(path.join(home, '.pi', 'agent', 'sessions'));
  const wslUncRoot = buildWslSessionsUncRoot(vaultPath, context);
  if (wslUncRoot) {
    roots.push(wslUncRoot);
  }
  return [...new Set(roots)];
}

function isLogicalSessionId(value: string | null | undefined): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && !isPiSessionPathReference(value);
}

export function isPiSessionPathReference(
  value: string | null | undefined,
): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && (
    trimmed.includes('/')
    || trimmed.includes('\\')
    || trimmed.endsWith('.jsonl')
  );
}

export function resolvePiSessionFileHint(
  persistedPath: string | null | undefined,
  logicalSessionId: string | null | undefined,
  vaultPath: string | null,
  context?: ProviderHistoryPathContext,
): string | null {
  if (!context) {
    const target = persistedPath ?? logicalSessionId;
    return target ? findPiSessionFile(target, vaultPath) : null;
  }

  const roots = getTrustedRoots(vaultPath, context);
  const pathReference = persistedPath?.trim()
    || (isPiSessionPathReference(logicalSessionId)
      ? logicalSessionId.trim()
      : null);
  const resolvedPathReference = pathReference
    ? path.resolve(vaultPath ?? process.cwd(), pathReference)
    : null;
  if (
    resolvedPathReference
    && roots.some(root => isPathWithinRoot(resolvedPathReference, root))
    && isFile(resolvedPathReference)
  ) {
    return resolvedPathReference;
  }
  if (!isLogicalSessionId(logicalSessionId)) {
    return null;
  }

  for (const root of roots) {
    const resolved = findPiSessionFileInRoot(logicalSessionId, root);
    if (resolved && isPathWithinRoot(resolved, root) && isFile(resolved)) {
      return resolved;
    }
  }
  return null;
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
