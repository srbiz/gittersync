import { createPinia, setActivePinia } from 'pinia';
import { COLLECTIONS_DB_NAME, META_DB_NAME } from 'gittersync';
import { useTodoStore } from '@/stores/todos';

export type TodoStore = ReturnType<typeof useTodoStore>;

/** Fresh Pinia + a store already running in local-only mode. */
export async function makeLocalStore(): Promise<{ store: TodoStore; pinia: ReturnType<typeof createPinia> }> {
    const pinia = createPinia();
    setActivePinia(pinia);
    localStorage.clear();
    sessionStorage.clear();
    const store = useTodoStore();
    await store.startLocalOnly();
    store.dismissNotice();
    return { store, pinia };
}

/** fake-indexeddb keeps its databases for the whole process — wipe between tests. */
export async function wipeDatabases(): Promise<void> {
    for (const name of [META_DB_NAME, COLLECTIONS_DB_NAME]) {
        await new Promise<void>((resolve) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
            request.onblocked = () => resolve();
        });
    }
}

/** Close the store's database handle, then delete the databases. */
export async function teardownStore(store: TodoStore): Promise<void> {
    store.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await wipeDatabases();
}
