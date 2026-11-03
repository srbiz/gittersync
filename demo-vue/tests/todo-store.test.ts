/**
 * @vitest-environment jsdom
 */

/**
 * Vue 3 + Pinia todo demo — store tests
 *
 * These exercise the offline-first path end to end: the store talks to a real
 * (fake-indexeddb) IndexedDB through GitterSync's LocalDB, with no GitHub
 * involved. That is exactly what "Try it offline" does in the browser.
 */

import 'fake-indexeddb/auto';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { AuthError, ConflictError, LocalDB, RateLimitError, ValidationError } from 'gittersync';
import { TODO_COLLECTION, describeError, newTodoId, useTodoStore } from '@/stores/todos';
import { teardownStore, type TodoStore } from './helpers';

let store: TodoStore;

async function startLocal(): Promise<void> {
    await store.startLocalOnly();
    expect(store.localOnly).toBe(true);
    expect(store.connected).toBe(false);
}

beforeEach(() => {
    setActivePinia(createPinia());
    store = useTodoStore();
    localStorage.clear();
    sessionStorage.clear();
});

afterEach(async () => {
    // disconnect() closes the LocalDB, releasing the IndexedDB connections
    await teardownStore(store);
});

describe('local-only mode', () => {
    it('opens the local database and registers the todos collection', async () => {
        await startLocal();
        expect(store.todos).toEqual([]);
        expect(store.notice?.type).toBe('info');
    });

    it('is reusable after a disconnect', async () => {
        await startLocal();
        await store.addTodo('first');
        store.disconnect();
        expect(store.todos).toEqual([]);
        expect(store.localOnly).toBe(false);

        await startLocal();
        // IndexedDB survived the disconnect, so the todo comes back
        expect(store.todos.map((todo) => todo.title)).toEqual(['first']);
    });

    it('reports a friendly notice instead of failing when asked to sync', async () => {
        await startLocal();
        store.dismissNotice();

        await store.syncNow();
        expect(store.notice?.text).toMatch(/local-only/i);

        await store.pull();
        await store.push();
        await store.compact();
        expect(store.todos).toHaveLength(0);
    });
});

describe('todo CRUD', () => {
    beforeEach(async () => {
        await startLocal();
        store.dismissNotice();
    });

    it('adds a todo and persists it to IndexedDB', async () => {
        const todo = await store.addTodo('  Buy milk  ');

        expect(todo).not.toBeNull();
        expect(todo!.title).toBe('Buy milk');
        expect(todo!.done).toBe(false);
        expect(store.todos).toHaveLength(1);

        // Re-reading from the database must show the same state
        await store.refreshFromLocal();
        expect(store.todos.map((item) => item.title)).toEqual(['Buy milk']);
    });

    it('ignores blank titles and over-long titles', async () => {
        expect(await store.addTodo('   ')).toBeNull();
        expect(await store.addTodo('x'.repeat(201))).toBeNull();
        expect(store.todos).toHaveLength(0);
        expect(store.notice?.type).toBe('error');
    });

    it('toggles completion and stamps completedAt', async () => {
        const todo = (await store.addTodo('Ship it'))!;

        await store.toggleTodo(todo.id);
        expect(store.todos[0].done).toBe(true);
        expect(store.todos[0].completedAt).not.toBeNull();

        await store.toggleTodo(todo.id);
        expect(store.todos[0].done).toBe(false);
        expect(store.todos[0].completedAt).toBeNull();

        await store.refreshFromLocal();
        expect(store.todos[0].done).toBe(false);
    });

    it('renames a todo', async () => {
        const todo = (await store.addTodo('Draft title'))!;
        await store.renameTodo(todo.id, '  Final title  ');

        expect(store.todos[0].title).toBe('Final title');
        await store.refreshFromLocal();
        expect(store.todos[0].title).toBe('Final title');
    });

    it('deletes a todo so other devices converge instead of resurrecting it', async () => {
        const todo = (await store.addTodo('Temporary'))!;
        await store.removeTodo(todo.id);

        expect(store.todos).toHaveLength(0);
        // A soft delete must survive a re-read — the changelog entry is what
        // tells the other devices to remove it too.
        await store.refreshFromLocal();
        expect(store.todos).toHaveLength(0);
    });

    it('clears completed todos and reports how many went', async () => {
        const a = (await store.addTodo('one'))!;
        await store.addTodo('two');
        await store.toggleTodo(a.id);

        expect(await store.clearCompleted()).toBe(1);
        expect(store.todos.map((todo) => todo.title)).toEqual(['two']);
        await store.refreshFromLocal();
        expect(store.todos).toHaveLength(1);
    });

    it('queues a changelog entry for every mutation', async () => {
        const todo = (await store.addTodo('queued'))!;
        await store.toggleTodo(todo.id);
        await store.renameTodo(todo.id, 'renamed');
        await store.removeTodo(todo.id);

        // Read the queue through a second handle on the same IndexedDB
        // databases: LocalDB is just a wrapper over named IDB stores, so this
        // proves the writes were journaled rather than applied in memory.
        const probe = new LocalDB();
        await probe.init();
        const queued = await probe.getPendingChangelogCount();
        await probe.close();

        expect(queued).toBe(4); // create + update + update + delete
        expect(store.pendingChanges).toBe(0); // nothing pushed without a repo
    });
});

describe('filters and getters', () => {
    beforeEach(async () => {
        await startLocal();
        const keep = (await store.addTodo('active one'))!;
        await store.addTodo('active two');
        const done = (await store.addTodo('done one'))!;
        await store.toggleTodo(done.id);
        expect(keep.title).toBe('active one');
        store.dismissNotice();
    });

    it('counts active and completed todos', () => {
        expect(store.activeCount).toBe(2);
        expect(store.completedCount).toBe(1);
    });

    it('filters the visible list', () => {
        expect(store.visibleTodos).toHaveLength(3);

        store.setFilter('active');
        expect(store.filter).toBe('active');
        expect(store.visibleTodos.map((todo) => todo.title).sort()).toEqual(['active one', 'active two']);

        store.setFilter('completed');
        expect(store.visibleTodos.map((todo) => todo.title)).toEqual(['done one']);

        store.setFilter('all');
        expect(store.visibleTodos).toHaveLength(3);
    });

    it('sorts newest first', async () => {
        // createdAt has millisecond resolution; force a distinguishable order
        const newer = (await store.addTodo('newest'))!;
        expect(store.sortedTodos[0].id).toBe(newer.id);
    });
});

describe('bootstrap without stored credentials', () => {
    it('does nothing when there is no unlockable token', async () => {
        const connected = await store.bootstrap();
        expect(connected).toBe(false);
        expect(store.connected).toBe(false);
        expect(store.localOnly).toBe(false);
    });
});

describe('notices', () => {
    it('sets and dismisses a notice', () => {
        store.notify('success', 'Saved');
        expect(store.notice).toEqual({ type: 'success', text: 'Saved' });
        store.dismissNotice();
        expect(store.notice).toBeNull();
    });
});

describe('describeError', () => {
    it('explains a rate limit in terms a user can act on', () => {
        const message = describeError(new RateLimitError(new Date(Date.now() + 5 * 60_000), 0));
        expect(message).toMatch(/rate limit/i);
        expect(message).toMatch(/5 min/);
        expect(message).toMatch(/saved locally/i);
    });

    it('surfaces the conflicting path', () => {
        expect(describeError(new ConflictError('collections/todos.json', 3))).toMatch(
            /collections\/todos\.json/,
        );
    });

    it('explains auth failures', () => {
        expect(describeError(new AuthError(401))).toMatch(/token/i);
    });

    it('explains validation failures', () => {
        expect(describeError(new ValidationError('files/../x', 'bad path'))).toMatch(/invalid input/i);
    });

    it('falls back to the error message or the raw value', () => {
        expect(describeError(new Error('boom'))).toBe('boom');
        expect(describeError('boom')).toBe('boom');
    });
});

describe('newTodoId', () => {
    it('generates unique ids', () => {
        const ids = new Set(Array.from({ length: 200 }, () => newTodoId()));
        expect(ids.size).toBe(200);
    });
});

describe('collection name', () => {
    it('is a valid GitterSync collection name', () => {
        expect(TODO_COLLECTION).toBe('todos');
        expect(TODO_COLLECTION).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    });
});

// Keep the mocked-adapter style test honest: the store never talks to GitHub
// unless a service exists.
describe('sync guards', () => {
    it('does not call the network when no service is connected', async () => {
        const spy = vi.spyOn(globalThis, 'fetch');
        await startLocal();
        await store.syncNow();
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });
});
