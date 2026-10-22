import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { Snapshots } from '../src/snapshots.ts';

let workspace: string;
let home: string;

beforeEach(async () => {
	workspace = await mkdtemp(join(tmpdir(), 'retri-ws-'));
	home = await mkdtemp(join(tmpdir(), 'retri-home-'));
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
	await rm(home, { recursive: true, force: true });
});

const write = async (path: string, text: string) => {
	await mkdir(join(workspace, path, '..'), { recursive: true });
	await writeFile(join(workspace, path), text);
};
const read = (path: string) => readFile(join(workspace, path), 'utf8');
const exists = (path: string) => existsSync(join(workspace, path));
const snapshotGit = (...args: string[]) => {
	const id = createHash('sha256').update(workspace).digest('hex').slice(0, 16);
	return execFileSync('git', ['--git-dir', join(home, 'snapshots', id), ...args], { input: '' }).toString();
};
const projectGit = (...args: string[]) =>
	execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: workspace }).toString();

test('restore puts changed, deleted and new files back the way they were', async () => {
	await write('a.txt', 'one');
	await write('dir/b.txt', 'two');
	const snapshots = new Snapshots(workspace, 'session-1', home);
	const before = await snapshots.take('0');

	await write('a.txt', 'changed');
	await rm(join(workspace, 'dir/b.txt'));
	await write('c.txt', 'new');
	await write('fresh/d.txt', 'new dir');

	await snapshots.restore(before);

	expect(await read('a.txt')).toBe('one');
	expect(await read('dir/b.txt')).toBe('two');
	expect(exists('c.txt')).toBe(false);
	expect(exists('fresh')).toBe(false);
});

test('files the project ignores are never touched', async () => {
	await write('.gitignore', 'ignored/\n');
	await write('ignored/keep.txt', 'keep');
	await write('node_modules/pkg/index.js', 'dependency');
	const snapshots = new Snapshots(workspace, 'session-1', home);
	const before = await snapshots.take('0');

	await write('ignored/later.txt', 'made after the checkpoint');
	await write('node_modules/pkg/index.js', 'reinstalled');

	await snapshots.restore(before);

	expect(await read('ignored/keep.txt')).toBe('keep');
	expect(await read('ignored/later.txt')).toBe('made after the checkpoint');
	expect(await read('node_modules/pkg/index.js')).toBe('reinstalled');
});

test("the project's own git repository is left alone", async () => {
	await write('a.txt', 'one');
	projectGit('init', '--quiet');
	projectGit('add', '.');
	projectGit('commit', '--quiet', '-m', 'first');
	const head = projectGit('rev-parse', 'HEAD');
	const snapshots = new Snapshots(workspace, 'session-1', home);
	const before = await snapshots.take('0');

	await write('a.txt', 'two');
	await snapshots.restore(before);

	expect(await read('a.txt')).toBe('one');
	expect(projectGit('rev-parse', 'HEAD')).toBe(head);
	expect(projectGit('status', '--porcelain')).toBe('');
	expect(projectGit('stash', 'list')).toBe('');
});

test('two sessions in one folder keep separate staging', async () => {
	await write('a.txt', 'one');
	const first = new Snapshots(workspace, 'session-1', home);
	const second = new Snapshots(workspace, 'session-2', home);
	const one = await first.take('0');

	await write('a.txt', 'two');
	await second.take('0');
	await first.restore(one);

	expect(await read('a.txt')).toBe('one');
});

test("discarding a session's snapshots frees them and leaves other sessions' alone", async () => {
	await write('a.txt', 'shared');
	const first = new Snapshots(workspace, 'session-1', home);
	const second = new Snapshots(workspace, 'session-2', home);
	const kept = await second.take('0');
	await write('b.txt', 'only the first session saw this');
	await first.take('0');
	const onlyFirst = snapshotGit('hash-object', join(workspace, 'b.txt')).trim();

	// Make every object old enough to be pruned.
	const objects = join(snapshotGit('rev-parse', '--absolute-git-dir').trim(), 'objects');
	const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
	for (const dir of await readdir(objects)) {
		if (!/^[0-9a-f]{2}$/.test(dir)) continue;
		for (const file of await readdir(join(objects, dir))) await utimes(join(objects, dir, file), old, old);
	}

	await first.discard();

	expect(snapshotGit('for-each-ref', '--format=%(refname)')).toBe('refs/retri/session-2/0\n');
	expect(existsSync(join(objects, onlyFirst.slice(0, 2), onlyFirst.slice(2)))).toBe(false);
	await second.restore(kept);
	expect(await read('a.txt')).toBe('shared');
	expect(exists('b.txt')).toBe(false);
});

test('discarding a session that never took a snapshot does nothing', async () => {
	await new Snapshots(workspace, 'session-1', home).discard();
	expect(existsSync(join(home, 'snapshots'))).toBe(false);
});
