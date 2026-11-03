/**
 * A single todo item. Stored in the `todos` collection of the GitHub repo
 * (one JSON document per todo) plus IndexedDB on this device.
 */
export interface Todo {
    id: string;
    title: string;
    done: boolean;
    createdAt: string;
    updatedAt: string;
    /** ISO timestamp, or null while the todo is still open */
    completedAt: string | null;
}

export type TodoFilter = 'all' | 'active' | 'completed';

/** Transient UI notice shown by ToastHost.vue */
export interface Notice {
    type: 'success' | 'error' | 'info';
    text: string;
}
