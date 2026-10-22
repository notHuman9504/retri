import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Never worth snapshotting, even in a project that doesn't ignore them. */
const ALWAYS_IGNORED = ['node_modules/', '.DS_Store'];

/**
 * Copies of the workspace, kept in a private git repository outside it.
 *
 * The project's own git history is never read or touched. Each snapshot is a git tree (the files the
 * project's .gitignore lets through), held alive by a ref. Each session stages through its own index,
 * so two sessions in the same folder don't collide.
 */
export class Snapshots {
	private readonly gitDir: string;
	private readonly indexFile: string;
	private ready?: Promise<void>;

	constructor(
		private readonly workspace: string,
		private readonly session: string,
		home = process.env.RETRI_HOME ?? join(homedir(), '.pi', 'agent', 'retri'),
	) {
		const id = createHash('sha256').update(workspace).digest('hex').slice(0, 16);
		this.gitDir = join(home, 'snapshots', id);
		this.indexFile = join(this.gitDir, `index-${session}`);
	}

	/** Saves the workspace as it is now and returns the snapshot's id. */
	async take(name: string) {
		await this.init();
		await this.git('add', '--all');
		const tree = (await this.git('write-tree')).trim();
		await this.git('update-ref', `refs/retri/${this.session}/${name}`, tree);
		return tree;
	}

	/**
	 * Puts the workspace back to a snapshot: changed files are rewritten, deleted ones come back, and new
	 * ones are removed. Files the project ignores are left alone.
	 */
	async restore(tree: string) {
		const now = await this.take(`before-restore-${Date.now()}`);
		// A two-tree read-tree with -u changes only the paths that differ between the two snapshots.
		await this.git('read-tree', '-m', '-u', now, tree);
	}

	/**
	 * Drops this session's snapshots once it can no longer rewind to them. Objects other sessions still
	 * refer to are kept, and so are any written in the last hour, which may belong to a snapshot another
	 * session is taking right now.
	 */
	async discard() {
		if (!this.ready) return; // nothing was ever snapshotted
		await this.ready;
		const refs = await this.git('for-each-ref', '--format=delete %(refname)', `refs/retri/${this.session}/`);
		if (refs) await this.gitWithInput(refs, 'update-ref', '--stdin');
		await rm(this.indexFile, { force: true });
		await this.git('prune', '--expire=1.hour.ago');
	}

	private init() {
		this.ready ??= (async () => {
			await mkdir(this.gitDir, { recursive: true });
			await exec('git', ['init', '--quiet', '--bare', this.gitDir]);
			await mkdir(join(this.gitDir, 'info'), { recursive: true });
			await writeFile(join(this.gitDir, 'info', 'exclude'), ALWAYS_IGNORED.join('\n') + '\n');
		})();
		return this.ready;
	}

	private git(...args: string[]) {
		return this.gitWithInput('', ...args);
	}

	private async gitWithInput(input: string, ...args: string[]) {
		const run = exec(
			'git',
			[
				// The user's git settings must not change what a snapshot holds or run anything.
				'-c', 'core.autocrlf=false',
				'-c', 'core.fsmonitor=false',
				'-c', 'core.hooksPath=/dev/null',
				'--git-dir', this.gitDir,
				'--work-tree', this.workspace,
				...args,
			],
			{ cwd: this.workspace, env: { ...process.env, GIT_INDEX_FILE: this.indexFile }, maxBuffer: 64 * 1024 * 1024 },
		);
		run.child.stdin?.end(input);
		const { stdout } = await run;
		return stdout;
	}
}
