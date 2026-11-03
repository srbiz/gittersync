/**
 * Vue component tests — the todo UI against a real Pinia store in local-only
 * mode (IndexedDB via fake-indexeddb, no GitHub).
 */
import 'fake-indexeddb/auto';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { Pinia } from 'pinia';
import TodoInput from '@/components/TodoInput.vue';
import TodoItem from '@/components/TodoItem.vue';
import TodoFilters from '@/components/TodoFilters.vue';
import type { Todo } from '@/types';
import { makeLocalStore, teardownStore, type TodoStore } from './helpers';

let store: TodoStore;
let pinia: Pinia;

function todoFrom(overrides: Partial<Todo> = {}): Todo {
    const now = new Date().toISOString();
    return {
        id: 'todo-1',
        title: 'Write the docs',
        done: false,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        ...overrides,
    };
}

beforeEach(async () => {
    ({ store, pinia } = await makeLocalStore());
});

afterEach(async () => {
    await teardownStore(store);
});

describe('TodoInput.vue', () => {
    it('keeps Add disabled until there is a title, then adds the todo', async () => {
        const wrapper = mount(TodoInput, { global: { plugins: [pinia] } });
        const input = wrapper.find('input[type="text"]');
        const button = wrapper.find('button[type="submit"]');

        expect((button.element as HTMLButtonElement).disabled).toBe(true);

        await input.setValue('  Ship the demo  ');
        expect((button.element as HTMLButtonElement).disabled).toBe(false);

        await wrapper.find('form').trigger('submit');

        await vi.waitFor(() => expect(store.todos.map((todo) => todo.title)).toEqual(['Ship the demo']));
        // The input clears after a successful add
        await vi.waitFor(() => expect((input.element as HTMLInputElement).value).toBe(''));
    });

    it('does not add a blank todo', async () => {
        const wrapper = mount(TodoInput, { global: { plugins: [pinia] } });
        await wrapper.find('input[type="text"]').setValue('   ');
        await wrapper.find('form').trigger('submit');
        expect(store.todos).toHaveLength(0);
    });
});

describe('TodoItem.vue', () => {
    it('renders the title and an unchecked box', () => {
        const wrapper = mount(TodoItem, { props: { todo: todoFrom() }, global: { plugins: [pinia] } });
        expect(wrapper.text()).toContain('Write the docs');
        expect((wrapper.find('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false);
    });

    it('marks a done todo as checked and struck through', () => {
        const wrapper = mount(TodoItem, {
            props: { todo: todoFrom({ done: true, completedAt: new Date().toISOString() }) },
            global: { plugins: [pinia] },
        });
        expect((wrapper.find('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true);
        expect(wrapper.find('.todo-item').classes()).toContain('done');
    });

    it('toggles the todo through the store', async () => {
        const todo = (await store.addTodo('Toggle me'))!;
        const wrapper = mount(TodoItem, { props: { todo }, global: { plugins: [pinia] } });

        await wrapper.find('input[type="checkbox"]').setValue(true);

        await vi.waitFor(() => expect(store.todos[0].done).toBe(true));
        // …and the write reached IndexedDB
        await store.refreshFromLocal();
        expect(store.todos[0].done).toBe(true);
    });

    it('renames on double-click + Enter', async () => {
        const todo = (await store.addTodo('Old title'))!;
        const wrapper = mount(TodoItem, { props: { todo }, global: { plugins: [pinia] } });

        await wrapper.find('.todo-title').trigger('dblclick');
        const editor = wrapper.find('.todo-edit');
        expect(editor.exists()).toBe(true);

        await editor.setValue('New title');
        await editor.trigger('keydown.enter');

        await vi.waitFor(() => expect(store.todos[0].title).toBe('New title'));
    });

    it('cancels a rename with Escape', async () => {
        const todo = (await store.addTodo('Keep me'))!;
        const wrapper = mount(TodoItem, { props: { todo }, global: { plugins: [pinia] } });

        await wrapper.find('.todo-title').trigger('dblclick');
        const editor = wrapper.find('.todo-edit');
        await editor.setValue('Discarded');
        await editor.trigger('keydown.esc');

        expect(store.todos[0].title).toBe('Keep me');
    });

    it('deletes through the trash button', async () => {
        const todo = (await store.addTodo('Delete me'))!;
        const wrapper = mount(TodoItem, { props: { todo }, global: { plugins: [pinia] } });

        await wrapper.find('.todo-actions .danger').trigger('click');

        await vi.waitFor(() => expect(store.todos).toHaveLength(0));
    });
});

describe('TodoFilters.vue', () => {
    beforeEach(async () => {
        await store.addTodo('active one');
        const done = (await store.addTodo('done one'))!;
        await store.toggleTodo(done.id);
        store.dismissNotice();
    });

    it('shows live counts', () => {
        const wrapper = mount(TodoFilters, { global: { plugins: [pinia] } });
        expect(wrapper.text()).toContain('1 active');
        expect(wrapper.text()).toContain('1 done');
    });

    it('switches the filter and highlights the active tab', async () => {
        const wrapper = mount(TodoFilters, { global: { plugins: [pinia] } });
        const buttons = wrapper.findAll('.filter-btn');

        expect(buttons[0].classes()).toContain('active');
        await buttons[2].trigger('click');

        expect(store.filter).toBe('completed');
        expect(store.visibleTodos.map((todo) => todo.title)).toEqual(['done one']);
        expect(wrapper.findAll('.filter-btn')[2].classes()).toContain('active');
    });

    it('clears completed todos', async () => {
        const wrapper = mount(TodoFilters, { global: { plugins: [pinia] } });
        await wrapper.findAll('button').find((button) => button.text() === 'Clear completed')!.trigger('click');

        await vi.waitFor(() => {
            expect(store.todos.map((todo) => todo.title)).toEqual(['active one']);
            expect(store.completedCount).toBe(0);
        });
    });
});
