/**
 * GitterSync Demo — Simple App State
 *
 * A lightweight pub/sub state manager for the demo app.
 * No framework needed — just reactive enough for our UI.
 */

import type { GitHubSyncService } from 'gittersync';
import type { AppView, Task, Column, ColumnId } from './types';

export interface AppConfig {
    owner: string;
    repo: string;
    branch: string;
    passphrase: string;
}

export interface AppState {
    view: AppView;
    config: AppConfig | null;
    sync: GitHubSyncService | null;
    columns: Column[];
    syncing: boolean;
    online: boolean;
    pendingChanges: number;
    lastSyncAt: string | null;
    deviceId: string | null;
    rateLimitRemaining: number | null;
    repoSizeKb: number | null;
    cursor: string | null;
    message: { type: 'info' | 'error' | 'success'; text: string } | null;
}

type Listener = (state: AppState) => void;

const listeners = new Set<Listener>();

let state: AppState = {
    view: 'loading',
    config: null,
    sync: null,
    columns: getDefaultColumns(),
    syncing: false,
    online: navigator.onLine,
    pendingChanges: 0,
    lastSyncAt: null,
    deviceId: null,
    rateLimitRemaining: null,
    repoSizeKb: null,
    cursor: null,
    message: null,
};

export function getDefaultColumns(): Column[] {
    return [
        { id: 'todo', title: 'To Do', color: '#6b7280', tasks: [] },
        { id: 'in-progress', title: 'In Progress', color: '#3b82f6', tasks: [] },
        { id: 'review', title: 'Review', color: '#f59e0b', tasks: [] },
        { id: 'done', title: 'Done', color: '#10b981', tasks: [] },
    ];
}

export function getState(): AppState {
    return state;
}

export function setState(partial: Partial<AppState>): void {
    state = { ...state, ...partial };
    for (const listener of listeners) {
        listener(state);
    }
}

export function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function showMessage(type: 'info' | 'error' | 'success', text: string, duration = 4000): void {
    setState({ message: { type, text } });
    if (duration > 0) {
        setTimeout(() => {
            if (state.message?.text === text) {
                setState({ message: null });
            }
        }, duration);
    }
}

export function moveTask(taskId: string, fromColumnId: ColumnId, toColumnId: ColumnId, newPosition: number): void {
    const columns = state.columns.map(col => ({ ...col, tasks: [...col.tasks] }));
    const fromCol = columns.find(c => c.id === fromColumnId)!;
    const toCol = columns.find(c => c.id === toColumnId)!;
    const taskIndex = fromCol.tasks.findIndex(t => t.id === taskId);
    if (taskIndex === -1) return;

    const movedTask = fromCol.tasks.splice(taskIndex, 1)[0];
    const updatedTask = { ...movedTask, columnId: toColumnId, position: newPosition };
    toCol.tasks.splice(newPosition, 0, updatedTask);

    // Re-index positions in both columns
    fromCol.tasks.forEach((t, i) => (t.position = i));
    toCol.tasks.forEach((t, i) => (t.position = i));

    setState({ columns });
}