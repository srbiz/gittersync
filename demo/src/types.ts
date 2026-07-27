/**
 * GitterSync Demo — Type Definitions
 */

export type Priority = 'low' | 'medium' | 'high' | 'critical';
export type ColumnId = 'todo' | 'in-progress' | 'review' | 'done';

export interface Label {
    id: string;
    text: string;
    color: string;
}

export interface Task {
    id: string;
    title: string;
    description: string;
    priority: Priority;
    assignee: string;
    dueDate: string;
    labels: Label[];
    columnId: ColumnId;
    position: number;
    attachments: TaskAttachment[];
    createdAt: string;
    updatedAt: string;
}

export interface TaskAttachment {
    id: string;
    name: string;
    path: string;
    mimeType: string;
    size: number;
    uploadedAt: string;
}

export interface Column {
    id: ColumnId;
    title: string;
    color: string;
    tasks: Task[];
}

export type AppView = 'setup' | 'board' | 'loading';