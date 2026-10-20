import type { ProjectedSessionEntry, SessionBoundaryDraft } from '@earendil-works/pi-coding-agent';

/** The custom message that carries the notes. Only the latest one stays in context. */
export const NOTES_TYPE = 'retri-notes';

/**
 * Context edits that hide everything after the checkpoint's entry from the model.
 *
 * Pi keeps the raw history; a `context_edit` with `replacement: null` only removes an entry from what the
 * model sees from now on. The user's own messages stay, so instructions given mid-run are never lost,
 * and earlier notes messages go, because the new one repeats every note.
 */
export function forgetAfter(context: ProjectedSessionEntry[], checkpointEntryId: string): SessionBoundaryDraft[] {
	const at = context.findIndex(({ sourceEntry }) => sourceEntry.id === checkpointEntryId);
	if (at === -1) throw new Error(`Checkpoint entry ${checkpointEntryId} is no longer in context; it may have been compacted.`);

	return context
		.filter(({ sourceEntry, messages }, i) => {
			if (messages.length === 0) return false; // already hidden, or never visible
			if (isNotes(sourceEntry)) return true;
			return i > at && isForgettable(sourceEntry);
		})
		.map(({ sourceEntry }) => ({ type: 'context_edit', targetId: sourceEntry.id, replacement: null }));
}

function isNotes(entry: ProjectedSessionEntry['sourceEntry']) {
	return entry.type === 'custom_message' && entry.customType === NOTES_TYPE;
}

function isForgettable(entry: ProjectedSessionEntry['sourceEntry']) {
	if (entry.type === 'custom_message') return true;
	if (entry.type !== 'message') return false;
	return entry.message.role === 'assistant' || entry.message.role === 'toolResult';
}
