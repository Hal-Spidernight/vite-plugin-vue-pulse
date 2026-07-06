// Workspace-aware click-to-jump: target parsing, root containment, workspace
// detection, and the VS Code-family editor check. The actual editor spawn is
// exercised manually (it would pop windows on the machine running the tests).
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveJumpTarget, findWorkspaceRoot, isVsCodeFamily } from '../dist/open-in-editor.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(repo, 'playground'); // the sample consumer app = vite root
const app = path.join(root, 'src', 'App.vue');

describe('resolveJumpTarget', () => {
  it('parses "<abs>:<line>:<col>" into file + goto', () => {
    expect(resolveJumpTarget(`${app}:12:3`, root)).toEqual({ file: app, goto: `${app}:12:3` });
  });
  it('defaults the column to 1 when only a line is given', () => {
    expect(resolveJumpTarget(`${app}:5`, root)).toEqual({ file: app, goto: `${app}:5:1` });
  });
  it('passes a bare file through without a position', () => {
    expect(resolveJumpTarget(app, root)).toEqual({ file: app, goto: app });
  });
  it('resolves root-relative paths', () => {
    expect(resolveJumpTarget('src/App.vue:5', root)).toEqual({ file: app, goto: `${app}:5:1` });
  });
  it('rejects paths escaping the root', () => {
    expect(resolveJumpTarget('/etc/hosts:1', root)).toBeNull();
    expect(resolveJumpTarget('../package.json:1', root)).toBeNull(); // repo file above the vite root
    expect(resolveJumpTarget(path.join(root, 'src') + '-x', path.join(root, 'src'))).toBeNull(); // prefix trick
  });
  it('rejects files that do not exist', () => {
    expect(resolveJumpTarget(path.join(root, 'src', 'Nope.vue') + ':1', root)).toBeNull();
  });
});

describe('findWorkspaceRoot', () => {
  it('walks up to the nearest .git ancestor (repo root, not the vite root)', () => {
    expect(findWorkspaceRoot(app)).toBe(repo);
  });
  it('returns null outside any repository', () => {
    expect(findWorkspaceRoot(path.join(os.tmpdir(), 'nowhere', 'x.vue'))).toBeNull();
  });
});

describe('isVsCodeFamily', () => {
  it('matches the VS Code-family CLIs, including full paths and .exe', () => {
    for (const e of ['code', 'code-insiders', 'cursor', 'windsurf', 'codium',
      '/Applications/Cursor.app/Contents/MacOS/Cursor', 'C:\\Program Files\\VS Code\\Code.exe']) {
      expect(isVsCodeFamily(e), e).toBe(true);
    }
  });
  it('leaves other editors to launch-editor', () => {
    for (const e of ['webstorm', 'vim', 'subl', 'zed',
      '/Applications/WebStorm.app/Contents/MacOS/webstorm']) {
      expect(isVsCodeFamily(e), e).toBe(false);
    }
  });
});
