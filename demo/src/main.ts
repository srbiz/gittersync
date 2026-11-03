/**
 * GitterSync Demo — Main Entry Point
 *
 * Bootstraps the application, checks for saved config,
 * and renders the appropriate view.
 */

import { getState, subscribe, setState, showMessage } from './state';
import { renderSetupView } from './views/setup-view';
import { renderBoard } from './views/board-view';
import { loadSavedConfig, rememberedPassphrase, tryReconnect } from './gittersync-adapter';
import { hasStoredToken } from 'gittersync';

// Generate a unique ID for new documents
export function generateId(): string {
    return crypto.randomUUID();
}

const app = document.getElementById('app')!;

// Global click-to-close messages
document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.message-toast')) {
        setState({ message: null });
    }
});

// Subscribe to view changes
subscribe((state) => {
    const currentView = app.dataset.currentView;
    if (currentView === state.view) return;
    app.dataset.currentView = state.view;

    app.innerHTML = '';

    switch (state.view) {
        case 'setup':
            renderSetupView(app);
            break;
        case 'loading':
            renderLoading(app);
            break;
        case 'board':
            renderBoard(app);
            break;
    }
});

// Subscribe to messages
subscribe((state) => {
    const existing = document.querySelector('.message-toast');
    if (existing) existing.remove();

    if (state.message) {
        const toast = document.createElement('div');
        toast.className = `message-toast ${state.message.type}`;
        toast.textContent = state.message.text;
        document.body.appendChild(toast);
    }
});

// Bootstrap
async function bootstrap(): Promise<void> {
    const saved = loadSavedConfig();

    // A reload in the same tab can reconnect on its own: the encrypted token is
    // in localStorage and the passphrase is in sessionStorage.
    if (saved?.owner && saved.repo && hasStoredToken() && rememberedPassphrase()) {
        setState({ view: 'loading' });
        try {
            if (await tryReconnect()) return; // initializeSync switches to 'board'
            showMessage('info', 'Stored token could not be unlocked — enter your passphrase to continue.');
        } catch (err) {
            showMessage('error', `Reconnect failed: ${(err as Error).message}`);
        }
    }

    setState({ view: 'setup' });
}

function renderLoading(container: HTMLElement): void {
    container.innerHTML = `
        <div class="loading-screen">
            <div class="spinner"></div>
            <h2>Initializing GitterSync</h2>
            <p style="color:var(--text-secondary)">Connecting to GitHub & setting up local database…</p>
        </div>
    `;
}

// Start
bootstrap();