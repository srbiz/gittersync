<script setup lang="ts">
import { useTodoStore } from '@/stores/todos';

const store = useTodoStore();
</script>

<template>
    <transition name="toast">
        <div v-if="store.notice" class="toast" :class="`toast-${store.notice.type}`" role="status">
            <span>{{ store.notice.text }}</span>
            <button class="toast-close" type="button" aria-label="Dismiss" @click="store.dismissNotice()">✕</button>
        </div>
    </transition>
</template>
