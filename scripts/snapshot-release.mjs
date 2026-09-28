// Snapshots the built dashboard into releases/<version>/ so the version
// history can serve it later.
//
// The compiled browser JS is gitignored (it's a build artifact of the .ts
// sources), so old builds cannot simply be read back out of a git tag.
// Instead each release keeps its own self-contained copy of the files a
// browser needs, which also means the history works on a host that only
// has the deployed files rather than the full repo.
//
//   node scripts/snapshot-release.mjs            snapshot the working tree
//   node scripts/snapshot-release.mjs v0.1.7     snapshot an existing tag
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSET_PATTERN = /\.(html|css|js|map|wgsl)$/;

function copyBuiltAssets(fromPublic, toDir) {
    fs.mkdirSync(toDir, { recursive: true });
    let copied = 0;
    for (const name of fs.readdirSync(fromPublic)) {
        if (!ASSET_PATTERN.test(name)) continue;
        fs.copyFileSync(path.join(fromPublic, name), path.join(toDir, name));
        copied++;
    }
    return copied;
}

function snapshotWorkingTree(version) {
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
    const target = path.join(ROOT, 'releases', version);
    fs.rmSync(target, { recursive: true, force: true });
    const copied = copyBuiltAssets(path.join(ROOT, 'public'), target);
    console.log(`snapshotted ${copied} files -> releases/${version}`);
}

function snapshotTag(tag) {
    // Build the tag in a throwaway worktree so the checkout in progress is
    // never disturbed.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'miner-release-'));
    try {
        execFileSync('git', ['worktree', 'add', '--detach', work, tag], { cwd: ROOT, stdio: 'inherit' });
        // The worktree has no node_modules of its own, so compile it with
        // the checkout's TypeScript against the worktree's own config.
        execFileSync(path.join(ROOT, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.public.json'], {
            cwd: work,
            stdio: 'inherit',
        });
        const version = JSON.parse(fs.readFileSync(path.join(work, 'package.json'), 'utf8')).version;
        const target = path.join(ROOT, 'releases', version);
        fs.rmSync(target, { recursive: true, force: true });
        const copied = copyBuiltAssets(path.join(work, 'public'), target);
        console.log(`snapshotted ${copied} files from ${tag} -> releases/${version}`);
    } finally {
        execFileSync('git', ['worktree', 'remove', '--force', work], { cwd: ROOT, stdio: 'inherit' });
    }
}

const tag = process.argv[2];
if (tag) {
    snapshotTag(tag);
} else {
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    snapshotWorkingTree(version);
}
