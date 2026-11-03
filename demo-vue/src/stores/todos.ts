/**
 * Pinia store — the single source of truth for the todo app.
 *
 * Everything is offline-first: mutations are written to IndexedDB through
 * GitterSync's LocalDB (which queues a changelog entry) and only reach GitHub
 * when a sync runs. A failed or unavailable network never blocks the UI.
 */
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import {
    AuthError,
    ConflictError,
    LocalDB,
    RateLimitError,
    ValidationError,
    type RateLimitInfo,
    type SyncStatus,
} from 'gittersync';
import type { GitHubSyncService } from 'gittersync';
import type { Notice, Todo, TodoFilter } from '@/types';
import {
    canReconnect,
    createService,
    forgetConnection,
    loadConfig,
    persistConfig,
    reconnectService,
    rememberPassphrase,
    type StoredConfig,
} from '@/lib/gittersync';

/** Collection name used in the GitHub repo and in IndexedDB. */
export const TODO_COLLECTION = 'todos';

const AUTO_SYNC_INTERVAL_MS = 30_000;

export function newTodoId(): string {
    const cryptoApi = (globalThis as { crypto?: Crypto }).crypto;
    if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
    return `todo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Turn a library error into something a todo app user can act on. */
export function describeError(error: unknown): string {
    if (error instanceof RateLimitError) {
        const minutes = Math.max(1, Math.ceil((error.resetAt.getTime() - Date.now()) / 60_000));
        return `GitHub rate limit reached — sync pauses for about ${minutes} min. Your todos stay saved locally.`;
    }
    if (error instanceof ConflictError) {
        return `GitHub rejected the write for ${error.path} after ${error.attempt} attempt(s). Pull to merge remote changes, then try again.`;
    }
    if (error instanceof ValidationError) {
        return `Invalid input: ${error.message}`;
    }
    if (error instanceof AuthError) {
        return `GitHub rejected the token (${error.message}). Check that it has the "repo" scope and is not expired.`;
    }
    return error instanceof Error ? error.message : String(error);
}

export const useTodoStore = defineStore('todos', () => {
    // ── State ────────────────────────────────────────────────────────────
    const todos = ref<Todo[]>([]);
    const filter = ref<TodoFilter>('all');
    const connected = ref(false);
    /** True when running without a repository (IndexedDB only, no syncing). */
    const localOnly = ref(false);
    const busy = ref(false);
    const bootstrapped = ref(false);
    const autoSync = ref(false);
    const repo = shallowRef<StoredConfig | null>(loadConfig());
    const status = shallowRef<SyncStatus | null>(null);
    const rateLimit = shallowRef<RateLimitInfo | null>(null);
    const notice = ref<Notice | null>(null);
    const service = shallowRef<GitHubSyncService | null>(null);
    /** Standalone database used by local-only mode. */
    const standaloneDb = shallowRef<LocalDB | null>(null);

    let noticeTimer: ReturnType<typeof setTimeout> | null = null;

    // ── Getters ──────────────────────────────────────────────────────────
    const sortedTodos = computed<Todo[]>(() =>
        [...todos.value].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)),
    );

    const visibleTodos = computed<Todo[]>(() => {
        if (filter.value === 'active') return sortedTodos.value.filter((todo) => !todo.done);
        if (filter.value === 'completed') return sortedTodos.value.filter((todo) => todo.done);
        return sortedTodos.value;
    });

    const activeCount = computed(() => todos.value.filter((todo) => !todo.done).length);
    const completedCount = computed(() => todos.value.filter((todo) => todo.done).length);
    const pendingChanges = computed(() => status.value?.pendingChanges ?? 0);
    const lastSyncAt = computed(() => status.value?.lastSyncAt ?? null);
    const autoSyncRunning = computed(() => autoSync.value);
    /** Reads that never touched the REST API — the demo's rate-limit savings. */
    const freeReads = computed(() => {
        const info = rateLimit.value;
        return info ? info.rawReads + info.rawMisses : 0;
    });

    // ── Notifications ────────────────────────────────────────────────────
    function notify(type: Notice['type'], text: string): void {
        notice.value = { type, text };
        if (noticeTimer) clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => {
            notice.value = null;
        }, type === 'error' ? 8_000 : 4_000);
    }

    function dismissNotice(): void {
        if (noticeTimer) clearTimeout(noticeTimer);
        notice.value = null;
    }

    // ── Local database helpers ───────────────────────────────────────────
    function localDb(): LocalDB {
        const db = service.value?.getLocalDb() ?? standaloneDb.value;
        if (!db) throw new Error('Not connected');
        return db;
    }

    function refreshStatus(): void {
        const sync = service.value;
        if (sync) status.value = sync.getStatus();
    }

    async function refreshFromLocal(): Promise<void> {
        const db = service.value?.getLocalDb() ?? standaloneDb.value;
        if (!db) {
            todos.value = [];
            return;
        }
        const docs = await db.getAllDocuments<Partial<Todo>>(TODO_COLLECTION);
        todos.value = docs
            .filter((doc) => !doc.deleted_at)
            .map((doc) => ({
                id: doc.id,
                title: typeof doc.data?.title === 'string' ? doc.data.title : '(untitled)',
                done: doc.data?.done === true,
                createdAt: doc.created_at,
                updatedAt: doc.updated_at,
                completedAt: typeof doc.data?.completedAt === 'string' ? doc.data.completedAt : null,
            }));
    }

    // ── Connection lifecycle ─────────────────────────────────────────────
    function handleStatusChange(next: SyncStatus): void {
        status.value = next;
    }

    async function connect(config: StoredConfig, token: string, passphrase: string, remember: boolean): Promise<void> {
        busy.value = true;
        try {
            rememberPassphrase(passphrase);
            const next = await createService(config, token, passphrase, [TODO_COLLECTION], handleStatusChange);
            service.value = next;
            connected.value = true;
            repo.value = config;
            persistConfig(config, remember);
            next.startAutoSync(AUTO_SYNC_INTERVAL_MS);
            autoSync.value = true;
            await refreshFromLocal();
            notify('success', `Connected to ${config.owner}/${config.repo}@${config.branch}`);
        } catch (error) {
            notify('error', describeError(error));
            throw error;
        } finally {
            busy.value = false;
        }
    }

    /** Restore a session on load: encrypted token + remembered passphrase. */
    async function bootstrap(): Promise<boolean> {
        if (bootstrapped.value) return connected.value;
        bootstrapped.value = true;

        if (!canReconnect()) return false;
        busy.value = true;
        try {
            const next = await reconnectService([TODO_COLLECTION], handleStatusChange);
            if (!next) return false;
            service.value = next;
            connected.value = true;
            repo.value = loadConfig();
            next.startAutoSync(AUTO_SYNC_INTERVAL_MS);
            autoSync.value = true;
            await refreshFromLocal();
            // Fold in anything other devices wrote while this tab was closed
            await next.pull().catch((error: unknown) => notify('info', describeError(error)));
            await refreshFromLocal();
            return true;
        } catch (error) {
            notify('error', describeError(error));
            return false;
        } finally {
            busy.value = false;
        }
    }

    /**
     * Run without a repository: LocalDB is a perfectly good offline database on
     * its own, so the app stays usable (and testable) with no GitHub token.
     * Nothing syncs until a repository is connected.
     */
    async function startLocalOnly(): Promise<void> {
        busy.value = true;
        try {
            const db = new LocalDB();
            await db.init();
            await db.registerCollection(TODO_COLLECTION);
            standaloneDb.value = db;
            localOnly.value = true;
            connected.value = false;
            await refreshFromLocal();
            notify('info', 'Local-only mode — todos are stored in this browser. Connect a repository to sync.');
        } catch (error) {
            notify('error', describeError(error));
        } finally {
            busy.value = false;
        }
    }

    function disconnect(): void {
        service.value?.stopAutoSync();
        autoSync.value = false;
        void standaloneDb.value?.close();
        standaloneDb.value = null;
        localOnly.value = false;
        service.value?.destroy().catch(() => undefined);
        service.value = null;
        connected.value = false;
        status.value = null;
        todos.value = [];
        forgetConnection();
        repo.value = null;
        bootstrapped.value = false;
        notify('info', 'Disconnected — the encrypted token was removed from this browser.');
    }

    // ── Mutations (offline-first) ────────────────────────────────────────
    async function addTodo(rawTitle: string): Promise<Todo | null> {
        const title = rawTitle.trim();
        if (!title) return null;
        if (title.length > 200) {
            notify('error', 'Todo titles are limited to 200 characters.');
            return null;
        }

        const now = new Date().toISOString();
        const todo: Todo = { id: newTodoId(), title, done: false, createdAt: now, updatedAt: now, completedAt: null };

        try {
            await localDb().create(TODO_COLLECTION, todo.id, { ...todo });
            todos.value = [...todos.value, todo];
            return todo;
        } catch (error) {
            notify('error', describeError(error));
            return null;
        }
    }

    /**
     * Field-level update: only the touched fields get a new timestamp, so a
     * concurrent edit of a *different* field on another device merges cleanly
     * instead of clobbering the whole document.
     */
    async function patchTodo(id: string, changes: Partial<Omit<Todo, 'id'>>): Promise<void> {
        try {
            const updated = await localDb().updateFields<Todo>(TODO_COLLECTION, id, {
                ...changes,
                updatedAt: new Date().toISOString(),
            });
            if (!updated) {
                notify('error', 'That todo no longer exists — pulling remote changes.');
                await pull();
                return;
            }
            const data = (updated.data ?? {}) as Partial<Todo>;
            todos.value = todos.value.map((todo) =>
                todo.id === id
                    ? {
                          ...todo,
                          ...data,
                          title: typeof data.title === 'string' ? data.title : todo.title,
                          done: data.done === true,
                          updatedAt: updated.updated_at,
                          completedAt: typeof data.completedAt === 'string' ? data.completedAt : null,
                      }
                    : todo,
            );
        } catch (error) {
            notify('error', describeError(error));
        }
    }

    async function toggleTodo(id: string): Promise<void> {
        const todo = todos.value.find((item) => item.id === id);
        if (!todo) return;
        await patchTodo(id, { done: !todo.done, completedAt: !todo.done ? new Date().toISOString() : null });
    }

    async function renameTodo(id: string, title: string): Promise<void> {
        const trimmed = title.trim();
        if (!trimmed) {
            notify('error', 'A todo needs a title — deleting it instead.');
            return;
        }
        await patchTodo(id, { title: trimmed.slice(0, 200) });
    }

    async function removeTodo(id: string): Promise<void> {
        try {
            // Soft delete + changelog entry: other devices converge instead of
            // resurrecting the todo on their next pull.
            await localDb().deleteDocument(TODO_COLLECTION, id);
            todos.value = todos.value.filter((todo) => todo.id !== id);
        } catch (error) {
            notify('error', describeError(error));
        }
    }

    async function clearCompleted(): Promise<number> {
        const done = todos.value.filter((todo) => todo.done);
        for (const todo of done) {
            await localDb().deleteDocument(TODO_COLLECTION, todo.id);
        }
        todos.value = todos.value.filter((todo) => !todo.done);
        return done.length;
    }

    function setFilter(next: TodoFilter): void {
        filter.value = next;
    }

    // ── Sync ─────────────────────────────────────────────────────────────
    async function pull(): Promise<void> {
        const sync = service.value;
        if (!sync) {
            notify('info', 'Local-only mode — connect a repository to sync.');
            return;
        }
        busy.value = true;
        try {
            const result = await sync.pull();
            await refreshFromLocal();
            notify(
                'info',
                result.type === 'none'
                    ? 'Already up to date.'
                    : `Pulled ${result.documentsMerged} document(s), applied ${result.changelogOps} changelog op(s).`,
            );
        } catch (error) {
            notify('error', describeError(error));
        } finally {
            busy.value = false;
            refreshTelemetry();
        }
    }

    async function push(): Promise<void> {
        const sync = service.value;
        if (!sync) {
            notify('info', 'Local-only mode — connect a repository to sync.');
            return;
        }
        busy.value = true;
        try {
            const result = await sync.push();
            notify('info', result.pushed > 0 ? `Pushed ${result.pushed} change(s).` : 'Nothing to push.');
        } catch (error) {
            notify('error', describeError(error));
        } finally {
            busy.value = false;
            refreshTelemetry();
        }
    }

    async function syncNow(): Promise<void> {
        const sync = service.value;
        if (!sync) {
            notify('info', 'Local-only mode — connect a repository to sync.');
            return;
        }
        busy.value = true;
        try {
            const result = await sync.sync();
            await refreshFromLocal();
            if (result.type === 'none') {
                notify('info', result.pushed > 0 ? `Pushed ${result.pushed} change(s).` : 'Everything is in sync.');
            } else {
                notify(
                    'success',
                    `Synced — pushed ${result.pushed}, merged ${result.documentsMerged} document(s), applied ${result.changelogOps} changelog op(s).`,
                );
            }
        } catch (error) {
            notify('error', describeError(error));
        } finally {
            busy.value = false;
            refreshTelemetry();
        }
    }

    async function compact(): Promise<void> {
        const sync = service.value;
        if (!sync) {
            notify('info', 'Local-only mode — connect a repository to sync.');
            return;
        }
        busy.value = true;
        try {
            const result = await sync.compact();
            notify(
                'success',
                `Compacted ${result.changelogsCompacted} changelog file(s), rewrote ${result.collectionsWritten.length} collection(s), purged ${result.purgedDeletes} expired delete(s).`,
            );
        } catch (error) {
            notify('error', describeError(error));
        } finally {
            busy.value = false;
            refreshTelemetry();
        }
    }

    function toggleAutoSync(enabled: boolean): void {
        const sync = service.value;
        if (!sync) return;
        if (enabled) {
            sync.startAutoSync(AUTO_SYNC_INTERVAL_MS);
            notify('info', `Auto-sync on (every ${AUTO_SYNC_INTERVAL_MS / 1000}s).`);
        } else {
            sync.stopAutoSync();
            notify('info', 'Auto-sync off.');
        }
        autoSync.value = enabled;
        refreshTelemetry();
    }

    function refreshTelemetry(): void {
        const sync = service.value;
        if (!sync) return;
        rateLimit.value = sync.getRateLimitInfo();
        refreshStatus();
    }

    return {
        // state
        todos,
        filter,
        connected,
        busy,
        repo,
        status,
        rateLimit,
        notice,
        service,
        // getters
        sortedTodos,
        visibleTodos,
        activeCount,
        completedCount,
        pendingChanges,
        lastSyncAt,
        autoSyncRunning,
        freeReads,
        // actions
        localOnly,
        bootstrap,
        connect,
        startLocalOnly,
        disconnect,
        refreshStatus,
        addTodo,
        toggleTodo,
        renameTodo,
        removeTodo,
        clearCompleted,
        setFilter,
        pull,
        push,
        syncNow,
        compact,
        toggleAutoSync,
        refreshTelemetry,
        refreshFromLocal,
        notify,
        dismissNotice,
    };
});
