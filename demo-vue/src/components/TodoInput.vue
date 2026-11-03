<script setup lang="ts">
import { ref } from 'vue';
import { useTodoStore } from '@/stores/todos';

const store = useTodoStore();
const title = ref('');

async function submit(): Promise<void> {
    const added = await store.addTodo(title.value);
    if (added) title.value = '';
}
</script>

<template>
    <form class="todo-input" @submit.prevent="submit">
        <input
            v-model="title"
            type="text"
            placeholder="What needs doing?"
            maxlength="200"
            autocomplete="off"
            aria-label="New todo title"
        />
        <button class="btn btn-primary" type="submit" :disabled="!title.trim()">Add</button>
    </form>
</template>
