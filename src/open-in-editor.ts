/**
 * Workspace-aware click-to-jump (dev-server side).
 *
 * launch-editor opens VS Code-family editors with `-r` (reuse window), so the
 * file lands in whatever editor window was focused LAST — not the window that
 * owns the file. For that family we spawn the CLI ourselves instead: no `-r`,
 * and the file's workspace folder (nearest ancestor with a `.git`) passed
 * alongside `-g`, so the editor focuses the window that has that workspace
 * open (or opens a new window for it) and jumps to the line. Everything else
 * (JetBrains, vim, …) keeps launch-editor's default behavior — those editors
 * route files to the owning project themselves.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import launchEditor from 'launch-editor';

// launch-editor's editor detection (running-process scan + LAUNCH_EDITOR/VISUAL/
// EDITOR env vars) is not part of its public API — deep-require the module.
const guessEditor = createRequire(import.meta.url)('launch-editor/guess') as
  (specifiedEditor?: string) => Array<string | null>;

// CLI basenames of the VS Code family (compared lowercased, .exe/.cmd/.bat stripped)
const VSCODE_FAMILY = new Set([
  'code', 'code-insiders', 'code - insiders', 'codium', 'vscodium',
  'cursor', 'windsurf', 'trae', 'antigravity',
]);

// trailing ":<line>[:<col>]" — anchored so Windows drive letters ("C:\…") survive
const POS_RE = /:(\d+)(?::(\d+))?$/;

export interface JumpTarget {
  /** absolute path of the file to open */
  file: string;
  /** editor goto spec: "<file>:<line>:<col>", or just the file when no position */
  goto: string;
}

/**
 * Parse "<path>[:<line>[:<col>]]" into an absolute file + goto spec.
 * Returns null when the path escapes `root` or doesn't exist — the endpoint
 * feeding this is reachable from the browser, so it must not open arbitrary
 * files.
 */
export function resolveJumpTarget(target: string, root: string): JumpTarget | null {
  const m = target.match(POS_RE);
  const file = path.resolve(root, target.replace(POS_RE, ''));
  const base = path.resolve(root);
  if (file !== base && !file.startsWith(base + path.sep)) return null;
  if (!fs.existsSync(file)) return null;
  return { file, goto: m ? `${file}:${m[1]}:${m[2] || 1}` : file };
}

/** Nearest ancestor of `file` containing a `.git` (a directory for a clone, a
 *  file for a worktree/submodule) — the folder the user opens as the workspace. */
export function findWorkspaceRoot(file: string): string | null {
  let dir = path.dirname(file);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function isVsCodeFamily(editor: string): boolean {
  const base = editor.split(/[\\/]/).pop() || '';
  return VSCODE_FAMILY.has(base.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase());
}

/** Open `target` ("<path>[:<line>[:<col>]]", path may be root-relative) in the
 *  user's editor, in the window owning the file's workspace when possible. */
export function openInEditor(target: string, root: string): void {
  const t = resolveJumpTarget(target, root);
  if (!t) return;

  const [editor] = guessEditor();
  if (editor && isVsCodeFamily(editor)) {
    const ws = findWorkspaceRoot(t.file);
    try {
      const child = spawn(editor, ws ? [ws, '-g', t.goto] : ['-g', t.goto], { stdio: 'ignore' });
      // CLI shim missing from PATH etc. — let launch-editor spawn + report instead
      child.on('error', () => launchEditor(t.goto));
      child.on('exit', (code) => { if (code) console.warn('[vue-pulse] editor exited with code', code); });
      child.unref();
      return;
    } catch { /* fall through to launch-editor */ }
  }
  launchEditor(t.goto);
}
