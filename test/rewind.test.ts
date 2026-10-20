import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, expect, test } from 'vitest';
import retri from '../src/index.ts';

// End to end through Pi itself, with a scripted model standing in for a real one. Each scripted reply
// also records the messages the model was sent, which is what a rewind has to change.

let workspace: string;
let agentDir: string;

beforeEach(async () => {
	workspace = await mkdtemp(join(tmpdir(), 'retri-ws-'));
	agentDir = await mkdtemp(join(tmpdir(), 'retri-agent-'));
	process.env.RETRI_HOME = join(agentDir, 'retri');
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
	await rm(agentDir, { recursive: true, force: true });
});

async function startPi(replies: AssistantMessage[]) {
	const sent: Message[][] = [];
	const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-1' }] });
	faux.setResponses(
		replies.map((reply) => (context) => {
			sent.push(structuredClone(context.messages));
			return reply;
		}),
	);

	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, 'auth.json'),
		modelsPath: join(agentDir, 'models.json'),
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: workspace,
		agentDir,
		settingsManager,
		extensionFactories: [retri],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: workspace,
		agentDir,
		model: faux.getModel(),
		modelRuntime,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(workspace),
		tools: ['bash', 'rewind'],
	});
	await session.bindExtensions({});
	return { session, sent };
}

const bash = (command: string) => fauxAssistantMessage(fauxToolCall('bash', { command }), { stopReason: 'toolUse' });
const rewind = (checkpoint: number, note: string) =>
	fauxAssistantMessage(fauxToolCall('rewind', { checkpoint, note }), { stopReason: 'toolUse' });
const text = (messages: Message[]) => JSON.stringify(messages);
const toolCalls = (messages: Message[]) =>
	messages.flatMap((m) => (m.role === 'assistant' ? m.content.filter((c) => c.type === 'toolCall').map((c) => c.name) : []));

test('rewind restores the files and removes the abandoned attempt from what the model sees next', async () => {
	await writeFile(join(workspace, 'app.txt'), 'v1\n');
	const { session, sent } = await startPi([
		bash('echo v2 > app.txt'),
		bash('echo WRONG > app.txt && echo litter > junk.txt'),
		rewind(1, 'Overwriting app.txt again made it worse; keep v2.'),
		fauxAssistantMessage('Done.'),
	]);

	await session.prompt('Update app.txt');
	session.dispose();

	// Files: back to checkpoint 1.
	expect(await readFile(join(workspace, 'app.txt'), 'utf8')).toBe('v2\n');
	expect(existsSync(join(workspace, 'junk.txt'))).toBe(false);

	// Context: the request after the rewind holds the kept work and the note, and nothing of the abandoned attempt.
	expect(sent).toHaveLength(4);
	const after = text(sent[3]);
	expect(after).toContain('echo v2 > app.txt');
	expect(after).toContain('[checkpoint 1]');
	expect(after).toContain('You rewound to checkpoint 1');
	expect(after).toContain('keep v2');
	expect(after).not.toContain('WRONG');
	expect(after).not.toContain('junk.txt');
	expect(toolCalls(sent[3])).toEqual(['bash']);

	// History: the abandoned attempt is hidden from the model, not deleted.
	expect(JSON.stringify(session.sessionManager.getEntries())).toContain('WRONG');
});

test('notes from earlier rewinds carry into later ones', async () => {
	await writeFile(join(workspace, 'app.txt'), 'v1\n');
	const { session, sent } = await startPi([
		bash('echo a > app.txt'),
		rewind(0, 'First note.'),
		bash('echo b > app.txt'),
		rewind(0, 'Second note.'),
		fauxAssistantMessage('Done.'),
	]);

	await session.prompt('Update app.txt');
	session.dispose();

	expect(await readFile(join(workspace, 'app.txt'), 'utf8')).toBe('v1\n');
	const last = text(sent[4]);
	expect(last).toContain('1. First note.');
	expect(last).toContain('2. Second note.');
	// Only one notes message is in context: the latest repeats every note.
	expect(last.split('You rewound to checkpoint').length - 1).toBe(1);
	expect(last).not.toContain('echo a');
	expect(last).not.toContain('echo b');
});

test('a rewind to a checkpoint that does not exist fails and changes nothing', async () => {
	await writeFile(join(workspace, 'app.txt'), 'v1\n');
	const { session, sent } = await startPi([
		bash('echo v2 > app.txt'),
		rewind(7, 'No such checkpoint.'),
		fauxAssistantMessage('Done.'),
	]);

	await session.prompt('Update app.txt');
	session.dispose();

	expect(await readFile(join(workspace, 'app.txt'), 'utf8')).toBe('v2\n');
	expect(text(sent[2])).toContain('There is no checkpoint 7 to return to');
});
