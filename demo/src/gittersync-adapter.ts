/**
 * GitterSync Demo — Adapter Layer
 *
 * Wraps the main GitterSync library for the demo app's use case.
 * Handles conversion between demo Task objects and GitterSync documents.
 */

import { GitHubSyncService, createDocument, mergeDocument, storeToken, retrieveToken, hasStoredToken, clearStoredToken } from 'gittersync';
import type { SyncedDocument, SyncStatus } from 'gittersync';
import type { AppConfig } from './state';
import type { Task, Column, ColumnId, Priority, Label, TaskAttachment } from './types';
import { setState, getState, getDefaultColumns, showMessage } from './state';

const CONFIG_KEY = 'gittersync_demo_config';
const DEFAULT_REPO_OWNER = 'srbiz';
const DEFAULT_REPO_NAME = 'gittersync-demo-data';

export function loadSavedConfig(): AppConfig | null {
    try {
        const raw = localStorage.getItem(CONFIG_KEY);
        if (!raw) return null;
        const config = JSON.parse(raw);
        // Don't store passphrase in localStorage
        return { ...config, passphrase: '' };
    } catch {
        return null;
    }
}

export function saveConfig(config: AppConfig): void {
    const toStore = { owner: config.owner, repo: config.repo, branch: config.branch };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(toStore));
}

export function getDefaultConfig(): AppConfig {
    return {
        owner: DEFAULT_REPO_OWNER,
        repo: DEFAULT_REPO_NAME,
        branch: 'main',
        passphrase: '',
    };
}

let syncService: GitHubSyncService | null = null;

export function getSyncService(): GitHubSyncService | null {
    return syncService;
}

export async function initializeSync(config: AppConfig, token: string): Promise<void> {
    // Create the sync service
    syncService = new GitHubSyncService({
        owner: config.owner,
        repo: config.repo,
        branch: config.branch,
        compactionThreshold: 20,
        onSyncStatusChange: (status: SyncStatus) => {
            setState({
                syncing: status.isSyncing,
                online: status.isOnline,
                pendingChanges: status.pendingChanges ?? 0,
                deviceId: status.deviceId,
                cursor: status.cursor?.sha ?? null,
            });
        },
    });

    // Initialize
    await syncService.init(token);

    // Register collections
    await syncService.registerCollections(['tasks', 'columns', 'metadata']);

    // Try to register demo data if it's the default repo
    if (config.owner === DEFAULT_REPO_OWNER && config.repo === DEFAULT_REPO_NAME) {
        await setupDemoDataRepo(config, token);
    }

    // Pull initial data
    const result = await syncService.pull();

    // Load data into state
    await loadFromLocalDb();

    // Start auto-sync
    syncService.startAutoSync(30000); // every 30s

    setState({ sync: syncService, view: 'board', config });
}

export async function setupDemoDataRepo(config: AppConfig, token: string): Promise<void> {
    // This is a no-op if the repo already has data.
    // The demo data repo will be pre-populated by us separately.
    // For now, just ensure the meta file exists.
    try {
        const sync = syncService!;
        await sync.pull();
    } catch {
        // Repo might not exist yet — that's okay, the user can use their own
    }
}

export async function loadFromLocalDb(): Promise<void> {
    const sync = syncService;
    if (!sync) return;
    const localDb = sync.getLocalDb();

    // Load tasks
    const columns = getDefaultColumns();
    for (const column of columns) {
        const docs = await localDb.getAllDocuments<Record<string, unknown>>(`column_${column.id}`);
        const tasks = docs
            .map(doc => docToTask(doc))
            .filter((t): t is Task => t !== null)
            .sort((a, b) => a.position - b.position);
        column.tasks = tasks;
    }

    setState({ columns });
}

export async function createTask(task: Task, columnId: ColumnId): Promise<void> {
    const sync = syncService;
    if (!sync) return;
    const localDb = sync.getLocalDb();

    const doc = createDocument(
        task.id,
        taskToRecord(task),
        localDb.getDeviceId(),
        new Date().toISOString()
    );

    await localDb.createDocument(`column_${columnId}`, doc);
    await loadFromLocalDb();
}

export async function updateTask(task: Task): Promise<void> {
    const sync = syncService;
    if (!sync) return;
    const localDb = sync.getLocalDb();

    const existing = await localDb.getDocument<Record<string, unknown>>(`column_${task.columnId}`, task.id);
    if (!existing) return;

    const updatedDoc = mergeDocument(existing, createDocument(
        task.id,
        taskToRecord(task),
        localDb.getDeviceId(),
        new Date().toISOString()
    ));

    await localDb.putDocument(`column_${task.columnId}`, updatedDoc);
    await loadFromLocalDb();
}

export async function deleteTask(taskId: string, columnId: ColumnId): Promise<void> {
    const sync = syncService;
    if (!sync) return;
    const localDb = sync.getLocalDb();
    await localDb.deleteDocument(`column_${columnId}`, taskId);
    await loadFromLocalDb();
}

export async function moveTaskToColumn(taskId: string, fromColumn: ColumnId, toColumn: ColumnId): Promise<void> {
    const sync = syncService;
    if (!sync) return;
    const localDb = sync.getLocalDb();

    // Get from source
    const doc = await localDb.getDocument<Record<string, unknown>>(`column_${fromColumn}`, taskId);
    if (!doc) return;

    // Update the columnId field
    const updatedData = { ...doc.data as Record<string, unknown>, columnId: toColumn };
    const updatedFields = {
        ...doc._fields,
        columnId: {
            updatedAt: new Date().toISOString(),
            device: localDb.getDeviceId(),
        },
    };

    // Soft-delete from source
    await localDb.deleteDocument(`column_${fromColumn}`, taskId);

    // Create in target
    const newDoc: SyncedDocument = {
        ...doc,
        data: updatedData,
        _fields: updatedFields,
        columnId: toColumn, // stored in data too
        deleted_at: null,
        deleted_by: null,
    };

    await localDb.createDocument(`column_${toColumn}`, newDoc);
    await loadFromLocalDb();
}

export async function pushChanges(): Promise<void> {
    if (!syncService) return;
    await syncService.push();
    showMessage('success', 'Changes pushed to GitHub');
}

export async function pullChanges(): Promise<void> {
    if (!syncService) return;
    const result = await syncService.pull();
    await loadFromLocalDb();
    showMessage('success', `Pull complete: ${result.type}`);
}

export async function fullSync(): Promise<void> {
    if (!syncService) return;
    const result = await syncService.sync();
    await loadFromLocalDb();
    showMessage('success', `Sync complete: ${result.type}`);
}

export async function compact(): Promise<void> {
    if (!syncService) return;
    await syncService.compact();
    showMessage('success', 'Compaction complete');
}

export async function uploadAttachment(task: Task, file: File): Promise<TaskAttachment | null> {
    const sync = syncService;
    if (!sync) return null;

    const base64Content = await fileToBase64(file);
    const filePath = `files/${task.id}/${file.name}`;

    const fileRef = await sync.uploadFile(filePath, base64Content, `Upload ${file.name} for task ${task.id}`);

    const attachment: TaskAttachment = {
        id: crypto.randomUUID(),
        name: file.name,
        path: fileRef.path,
        mimeType: file.type,
        size: file.size,
        uploadedAt: new Date().toISOString(),
    };

    const updatedTask = {
        ...task,
        attachments: [...(task.attachments || []), attachment],
    };

    await updateTask(updatedTask);
    return attachment;
}

export async function downloadAttachment(attachment: TaskAttachment): Promise<void> {
    const sync = syncService;
    if (!sync) return;

    const blob = await sync.downloadFile(attachment.path);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = attachment.name;
    a.click();
    URL.revokeObjectURL(url);
}

export async function getFullStatus(): Promise<void> {
    const sync = syncService;
    if (!sync) return;

    const status = await sync.getFullStatus();
    setState({
        pendingChanges: status.pendingChanges,
        cursor: status.cursor?.sha ?? null,
        rateLimitRemaining: status.rateLimitRemaining,
        repoSizeKb: status.repoSizeKb,
        deviceId: status.deviceId,
    });
}

// ─── Helpers ──────────────────────────────────────────────────────

function taskToRecord(task: Task): Record<string, unknown> {
    return {
        title: task.title,
        description: task.description,
        priority: task.priority,
        assignee: task.assignee,
        dueDate: task.dueDate,
        labels: JSON.stringify(task.labels || []),
        columnId: task.columnId,
        position: task.position,
        attachments: JSON.stringify(task.attachments || []),
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
    };
}

function docToTask(doc: SyncedDocument<Record<string, unknown>>): Task | null {
    if (doc.deleted_at) return null;
    const data = doc.data;
    return {
        id: doc.id,
        title: (data.title as string) || 'Untitled',
        description: (data.description as string) || '',
        priority: (data.priority as Priority) || 'medium',
        assignee: (data.assignee as string) || '',
        dueDate: (data.dueDate as string) || '',
        labels: parseJSON<Task['labels']>(data.labels, []),
        columnId: (data.columnId as ColumnId) || 'todo',
        position: (data.position as number) || 0,
        attachments: parseJSON<Task['attachments']>(data.attachments, []),
        createdAt: doc.created_at,
        updatedAt: doc.updated_at,
    };
}

function parseJSON<T>(value: unknown, fallback: T): T {
    if (typeof value === 'string') {
        try { return JSON.parse(value) as T; } catch { return fallback; }
    }
    return fallback;
}

function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result as string;
            // Remove data: URL prefix
            const base64 = result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}