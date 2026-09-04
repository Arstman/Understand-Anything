import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const skillDir = join(repoRoot, 'understand-anything-plugin', 'skills', 'understand');
const scanScript = join(skillDir, 'scan-project.mjs');
const importScript = join(skillDir, 'extract-import-map.mjs');
const fingerprintScript = join(skillDir, 'build-fingerprints.mjs');
const prepareScript = join(skillDir, 'prepare-incremental.mjs');
const finalizeScript = join(skillDir, 'finalize-incremental.mjs');
const mergeScript = join(skillDir, 'merge-batch-graphs.py');

const python = (() => {
  for (const command of ['python3', 'python']) {
    const probe = spawnSync(command, ['--version'], { encoding: 'utf-8' });
    if (probe.status === 0) return command;
  }
  throw new Error('Python 3 is required for incremental merge tests');
})();

const roots = [];

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function git(root, args) {
  return run('git', args, root).stdout.trim();
}

function writeProjectFile(root, path, content) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf-8');
}

function commit(root, message, { forcePaths = [] } = {}) {
  git(root, ['add', '-A']);
  for (const path of forcePaths) git(root, ['add', '-f', '--', path]);
  git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function setupRepository(files) {
  const root = mkdtempSync(join(tmpdir(), 'ua-incremental-test-'));
  roots.push(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test User']);
  writeProjectFile(root, '.gitignore', '.ua/\n.understand-anything/\n');
  for (const [path, content] of Object.entries(files)) writeProjectFile(root, path, content);
  const baseCommit = commit(root, 'baseline');
  buildBaseline(root, baseCommit);
  return { root, baseCommit };
}

function buildBaseline(root, baseCommit) {
  const intermediate = join(root, '.ua', 'intermediate');
  mkdirSync(intermediate, { recursive: true });
  const rawScanPath = join(intermediate, 'baseline-scan.json');
  run(process.execPath, [scanScript, root, rawScanPath, '--exclude-analysis-data'], root);
  const rawScan = JSON.parse(readFileSync(rawScanPath, 'utf-8'));

  const importInput = join(intermediate, 'baseline-import-input.json');
  const importOutput = join(intermediate, 'baseline-import-output.json');
  writeFileSync(
    importInput,
    JSON.stringify({ projectRoot: root, files: rawScan.files }),
    'utf-8',
  );
  run(process.execPath, [importScript, importInput, importOutput], root);
  const importMap = JSON.parse(readFileSync(importOutput, 'utf-8')).importMap;
  const scan = {
    name: 'fixture',
    description: 'fixture project',
    languages: [...new Set(rawScan.files.map(file => file.language))].sort(),
    frameworks: [],
    contentDigest: rawScan.contentDigest,
    files: rawScan.files,
    totalFiles: rawScan.totalFiles,
    filteredByIgnore: rawScan.filteredByIgnore,
    estimatedComplexity: rawScan.estimatedComplexity,
    importMap,
  };
  writeFileSync(join(intermediate, 'scan-result.json'), JSON.stringify(scan), 'utf-8');

  const fingerprintInput = join(intermediate, 'fingerprint-input.json');
  writeFileSync(
    fingerprintInput,
    JSON.stringify({
      projectRoot: root,
      filePaths: rawScan.files.map(file => file.path),
      gitCommitHash: baseCommit,
    }),
    'utf-8',
  );
  run(process.execPath, [fingerprintScript, fingerprintInput], root);

  const nodes = rawScan.files.map(file => ({
    id: `file:${file.path}`,
    type: 'file',
    name: file.path.split('/').at(-1),
    filePath: file.path,
    summary: file.path,
    tags: ['fixture'],
    complexity: 'simple',
  }));
  writeFileSync(
    join(root, '.ua', 'knowledge-graph.json'),
    JSON.stringify({
      version: '1.0.0',
      project: {
        name: 'fixture',
        languages: scan.languages,
        frameworks: [],
        description: 'fixture project',
        analyzedAt: '2026-01-01T00:00:00.000Z',
        gitCommitHash: baseCommit,
      },
      nodes,
      edges: [],
      layers: [{
        id: 'layer:source',
        name: 'Source',
        description: 'Source files',
        nodeIds: nodes.map(node => node.id),
      }],
      tour: [{
        order: 1,
        title: 'Overview',
        description: 'Read the project',
        nodeIds: nodes.map(node => node.id),
      }],
    }),
    'utf-8',
  );
  writeFileSync(
    join(root, '.ua', 'meta.json'),
    JSON.stringify({ gitCommitHash: baseCommit, analyzedFiles: nodes.length, version: '1.0.0' }),
    'utf-8',
  );
}

function prepare(root, baseCommit) {
  const result = run(process.execPath, [prepareScript, root, baseCommit], root);
  const intermediate = join(root, '.ua', 'intermediate');
  return {
    result,
    plan: JSON.parse(readFileSync(join(intermediate, 'incremental-plan.json'), 'utf-8')),
    scan: JSON.parse(readFileSync(join(intermediate, 'scan-result.json'), 'utf-8')),
    changedFiles: readFileSync(join(intermediate, 'changed-files.txt'), 'utf-8'),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('prepare-incremental.mjs', { timeout: 30_000 }, () => {
  it('refreshes imports in the same run and only schedules the structural source', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/d.ts': 'export const d = 4;\n',
    });
    writeProjectFile(root, 'src/a.ts', "import { b } from './b';\nexport const a = b;\n");
    commit(root, 'add import');

    const { plan, scan, changedFiles } = prepare(root, baseCommit);
    expect(plan.action).toBe('PARTIAL_UPDATE');
    expect(plan.filesToReanalyze).toEqual(['src/a.ts']);
    expect(changedFiles).toBe('src/a.ts\n');
    expect(scan.importMap['src/a.ts']).toEqual(['src/b.ts']);
    expect(scan.importMap['src/c.ts']).toEqual([]);
  });

  it('turns a local deletion into cleanup with an empty analyzer list', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/d.ts': 'export const d = 4;\n',
    });
    unlinkSync(join(root, 'src/b.ts'));
    commit(root, 'delete b');
    writeFileSync(
      join(root, '.ua', 'intermediate', 'batch-99.json'),
      JSON.stringify({
        nodes: [{ id: 'file:src/b.ts', type: 'file', filePath: 'src/b.ts' }],
        edges: [],
      }),
      'utf-8',
    );

    const { plan, scan, changedFiles } = prepare(root, baseCommit);
    expect(plan.action).toBe('PARTIAL_UPDATE');
    expect(plan.filesToReanalyze).toEqual([]);
    expect(plan.deletedFiles).toEqual(['src/b.ts']);
    expect(changedFiles).toBe('');
    expect(scan.files.map(file => file.path)).not.toContain('src/b.ts');
    expect(scan.importMap).not.toHaveProperty('src/b.ts');
    expect(() => readFileSync(join(root, '.ua', 'intermediate', 'batch-99.json'))).toThrow();
    const retained = JSON.parse(
      readFileSync(join(root, '.ua', 'intermediate', 'batch-existing.json'), 'utf-8'),
    );
    expect(retained.nodes.map(node => node.filePath)).not.toContain('src/b.ts');

    run(python, [mergeScript, root], root);
    run(process.execPath, [finalizeScript, root], root);
    const graph = JSON.parse(readFileSync(join(root, '.ua', 'knowledge-graph.json'), 'utf-8'));
    const fingerprints = JSON.parse(
      readFileSync(join(root, '.ua', 'fingerprints.json'), 'utf-8'),
    );
    expect(graph.nodes.map(node => node.filePath)).not.toContain('src/b.ts');
    expect(graph.layers.flatMap(layer => layer.nodeIds)).not.toContain('file:src/b.ts');
    expect(graph.tour.flatMap(step => step.nodeIds)).not.toContain('file:src/b.ts');
    expect(fingerprints.files).not.toHaveProperty('src/b.ts');
  });

  it('does not recover an import removed during this incremental run', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/d.ts': 'export const d = 4;\n',
    });
    writeProjectFile(root, 'src/a.ts', 'export const a = 1;\n');
    commit(root, 'remove import');

    const { plan, scan } = prepare(root, baseCommit);
    expect(plan.filesToReanalyze).toEqual(['src/a.ts']);
    expect(scan.importMap['src/a.ts']).toEqual([]);
    const intermediate = join(root, '.ua', 'intermediate');
    const retained = JSON.parse(readFileSync(join(intermediate, 'batch-existing.json'), 'utf-8'));
    writeFileSync(
      join(intermediate, 'batch-0.json'),
      JSON.stringify({
        nodes: [{
          id: 'file:src/a.ts',
          type: 'file',
          name: 'a.ts',
          filePath: 'src/a.ts',
          summary: 'a',
          tags: ['fixture'],
          complexity: 'simple',
        }],
        edges: [],
      }),
      'utf-8',
    );
    expect(retained.nodes.map(node => node.filePath)).not.toContain('src/a.ts');
    run(python, [mergeScript, root], root);
    const assembled = JSON.parse(
      readFileSync(join(intermediate, 'assembled-graph.json'), 'utf-8'),
    );
    expect(assembled.edges.filter(edge => edge.type === 'imports')).toHaveLength(0);
  });

  it('classifies implementation-only edits as SKIP and advances fingerprints via finalize', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export function value() { return 1; }\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/d.ts': 'export const d = 4;\n',
    });
    writeProjectFile(root, 'src/a.ts', 'export function value() { return 2; }\n');
    const headCommit = commit(root, 'implementation only');

    const { plan } = prepare(root, baseCommit);
    expect(plan.action).toBe('SKIP');
    expect(plan.cosmeticFiles).toEqual(['src/a.ts']);
    run(process.execPath, [finalizeScript, root], root);

    const meta = JSON.parse(readFileSync(join(root, '.ua', 'meta.json'), 'utf-8'));
    const fingerprints = JSON.parse(
      readFileSync(join(root, '.ua', 'fingerprints.json'), 'utf-8'),
    );
    expect(meta.gitCommitHash).toBe(headCommit);
    expect(fingerprints.gitCommitHash).toBe(headCommit);
    expect(Object.keys(fingerprints.files)).toHaveLength(4);
  });

  it('removes files newly covered by .understandignore without analyzing them', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'legacy/old.ts': 'export const old = true;\n',
    });
    writeProjectFile(root, '.understandignore', 'legacy/\n');
    commit(root, 'ignore legacy');

    const { plan } = prepare(root, baseCommit);
    expect(plan.filesToReanalyze).toEqual([]);
    expect(plan.deletedFiles).toEqual(['legacy/old.ts']);
    expect(plan.ignoredFiles).toContain('.understandignore');
    expect(plan.action).toBe('ARCHITECTURE_UPDATE');
  });

  it('handles renames and spaces as a delete plus add', () => {
    const { root, baseCommit } = setupRepository({
      'src/old name.ts': 'export const value = 1;\n',
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
    });
    renameSync(join(root, 'src/old name.ts'), join(root, 'src/new name.ts'));
    commit(root, 'rename spaced file');

    const { plan } = prepare(root, baseCommit);
    expect(plan.deletedFiles).toEqual(['src/old name.ts']);
    expect(plan.filesToReanalyze).toEqual(['src/new name.ts']);
  });

  it('keeps the same new-directory decision when preparation is retried', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/d.ts': 'export const d = 4;\n',
    });
    writeProjectFile(root, 'new-package/index.ts', 'export const added = true;\n');
    commit(root, 'add package');

    const first = prepare(root, baseCommit).plan;
    const second = prepare(root, baseCommit).plan;
    expect(first.action).toBe('ARCHITECTURE_UPDATE');
    expect(second.action).toBe(first.action);
    expect(second.filesToReanalyze).toEqual(['new-package/index.ts']);
  });

  it('does not advance the baseline for generated-artifact-only commits', () => {
    const { root, baseCommit } = setupRepository({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
      'src/c.ts': 'export const c = 3;\n',
      'src/d.ts': 'export const d = 4;\n',
    });
    writeProjectFile(root, '.ua/tracked-generated.json', '{}\n');
    commit(root, 'generated output', { forcePaths: ['.ua/tracked-generated.json'] });

    const { plan } = prepare(root, baseCommit);
    expect(plan.action).toBe('SKIP');
    expect(plan.generatedArtifactFiles).toEqual(['.ua/tracked-generated.json']);
    run(process.execPath, [finalizeScript, root], root);
    const meta = JSON.parse(readFileSync(join(root, '.ua', 'meta.json'), 'utf-8'));
    expect(meta.gitCommitHash).toBe(baseCommit);
  });
});

describe('finalize-incremental.mjs', { timeout: 30_000 }, () => {
  it('preserves local layer/tour text, removes dangling refs, and places new nodes by path', () => {
    const { root, baseCommit } = setupRepository({
      'src/api/a.ts': 'export const a = 1;\n',
      'src/ui/view.ts': 'export const view = 1;\n',
      'src/other.ts': 'export const other = 1;\n',
      'docs/readme.md': '# Docs\n',
    });
    const graphPath = join(root, '.ua', 'knowledge-graph.json');
    const previousGraph = JSON.parse(readFileSync(graphPath, 'utf-8'));
    previousGraph.layers = [
      {
        id: 'layer:api',
        name: 'API',
        description: 'API files',
        nodeIds: ['file:src/api/a.ts', 'file:missing.ts'],
      },
      {
        id: 'layer:ui',
        name: 'UI',
        description: 'UI files',
        nodeIds: ['file:src/ui/view.ts', 'file:src/other.ts', 'file:docs/readme.md'],
      },
    ];
    previousGraph.tour[0].nodeIds.push('file:missing.ts');
    writeFileSync(graphPath, JSON.stringify(previousGraph), 'utf-8');
    writeProjectFile(root, 'src/api/new.ts', "import { a } from './a';\nexport const value = a;\n");
    const headCommit = commit(root, 'add api file');
    const { plan } = prepare(root, baseCommit);
    expect(plan.action).toBe('PARTIAL_UPDATE');

    const intermediate = join(root, '.ua', 'intermediate');
    const retained = JSON.parse(readFileSync(join(intermediate, 'batch-existing.json'), 'utf-8'));
    const newNode = {
      id: 'file:src/api/new.ts',
      type: 'file',
      name: 'new.ts',
      filePath: 'src/api/new.ts',
      summary: 'new api',
      tags: ['api'],
      complexity: 'simple',
    };
    const aId = 'file:src/api/a.ts';
    writeFileSync(
      join(intermediate, 'assembled-graph.json'),
      JSON.stringify({
        nodes: [...retained.nodes, newNode],
        edges: [{ source: newNode.id, target: aId, type: 'imports', direction: 'forward', weight: 0.7 }],
      }),
      'utf-8',
    );

    run(process.execPath, [finalizeScript, root], root);
    const graph = JSON.parse(readFileSync(join(root, '.ua', 'knowledge-graph.json'), 'utf-8'));
    expect(graph.project.gitCommitHash).toBe(headCommit);
    expect(graph.layers.find(layer => layer.id === 'layer:api').nodeIds).toContain(newNode.id);
    expect(graph.layers.flatMap(layer => layer.nodeIds)).not.toContain('file:missing.ts');
    expect(graph.tour[0].title).toBe('Overview');
    expect(graph.tour[0].description).toBe('Read the project');
    expect(graph.tour[0].nodeIds.every(id => graph.nodes.some(node => node.id === id))).toBe(true);
  });
});
