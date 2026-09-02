import type { PiInstallationMethod } from '../settings';

export type PiExecutionMethod = 'host-native' | PiInstallationMethod;
export type PiExecutionPlatformOs = 'windows' | 'linux' | 'macos';
export type PiExecutionPlatformFamily = 'windows' | 'unix';

export interface PiExecutionTarget {
  method: PiExecutionMethod;
  platformFamily: PiExecutionPlatformFamily;
  platformOs: PiExecutionPlatformOs;
  distroName?: string;
}

export interface PiPathMapper {
  target: PiExecutionTarget;
  toTargetPath(hostPath: string): string | null;
  toHostPath(targetPath: string): string | null;
  mapTargetPathList(hostPaths: string[]): string[];
  canRepresentHostPath(hostPath: string): boolean;
}

export interface PiWslLaunchSpec {
  target: PiExecutionTarget;
  command: string;
  args: string[];
  spawnCwd: string;
  targetCwd: string;
  env: Record<string, string>;
  pathMapper: PiPathMapper;
}
