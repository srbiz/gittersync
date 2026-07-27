/**
 * Setup View — First-run configuration screen
 *
 * Allows the user to:
 * - Enter GitHub PAT (optionally encrypted with passphrase)
 * - Configure owner/repo/branch
 * - Use the default demo repo or their own
 */

import { setState, showMessage } from '../state';
import { loadSavedConfig, saveConfig, getDefaultConfig, initializeSync } from '../gittersync-adapter';
import { hasStoredToken, retrieveToken, storeToken, clearStoredToken } from 'gittersync';

export function renderSetupView(container: HTMLElement): void {
    const savedConfig = loadSavedConfig() || getDefaultConfig();
    const hasToken = hasStoredToken();

    container.innerHTML = `
        <div class="setup-screen">
            <div class="setup-card">
                <div class="logo">GS</div>
                <h1>GitterSync Demo</h1>
                <p class="subtitle">Kanban Board — powered by GitHub as a database</p>

                <div class="default-hint">
                    💡 Default: <code>srbiz/gittersync-demo-data</code> — works instantly with a PAT
                </div>

                <form id="setup-form">
                    <div class="form-group">
                        <label for="token">GitHub Personal Access Token</label>
                        <input type="password" id="token" placeholder="ghp_xxxxxxxxxxxx" ${hasToken ? '' : 'required'}>
                        <small style="color:var(--text-muted);font-size:0.75rem">Requires repo scope. <a href="https://github.com/settings/tokens" target="_blank" style="color:var(--accent)">Create one →</a></small>
                    </div>

                    <div class="form-group">
                        <label>
                            <input type="checkbox" id="encrypt-toggle" ${hasToken ? 'checked' : ''}>
                            Encrypt token with passphrase (secure localStorage)
                        </label>
                    </div>

                    <div id="passphrase-group" class="form-group" style="${hasToken ? '' : 'display:none'}">
                        <label for="passphrase">Passphrase</label>
                        <input type="password" id="passphrase" placeholder="Enter a passphrase to encrypt the token">
                    </div>

                    <div class="form-row">
                        <div class="form-group">
                            <label for="owner">Repository Owner</label>
                            <input type="text" id="owner" value="${savedConfig.owner}" required>
                        </div>
                        <div class="form-group">
                            <label for="repo">Repository Name</label>
                            <input type="text" id="repo" value="${savedConfig.repo}" required>
                        </div>
                    </div>

                    <div class="form-group">
                        <label for="branch">Branch</label>
                        <input type="text" id="branch" value="${savedConfig.branch}">
                    </div>

                    <button type="submit" class="btn-primary" style="width:100%;justify-content:center;padding:0.75rem" id="start-btn">
                        🚀 Start Demo
                    </button>
                </form>

                ${hasToken ? `<p style="text-align:center;margin-top:1rem"><button class="btn-sm btn-secondary" id="clear-token">Clear stored token</button></p>` : ''}
            </div>
        </div>
    `;

    const encryptToggle = document.getElementById('encrypt-toggle') as HTMLInputElement;
    const passphraseGroup = document.getElementById('passphrase-group')!;
    encryptToggle.addEventListener('change', () => {
        passphraseGroup.style.display = encryptToggle.checked ? '' : 'none';
    });

    const clearBtn = document.getElementById('clear-token');
    clearBtn?.addEventListener('click', () => {
        clearStoredToken();
        showMessage('success', 'Token cleared');
        renderSetupView(container);
    });

    const form = document.getElementById('setup-form')!;
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
        startBtn.disabled = true;
        startBtn.textContent = '⏳ Initializing…';

        try {
            const tokenInput = document.getElementById('token') as HTMLInputElement;
            const ownerInput = document.getElementById('owner') as HTMLInputElement;
            const repoInput = document.getElementById('repo') as HTMLInputElement;
            const branchInput = document.getElementById('branch') as HTMLInputElement;
            const passphraseInput = document.getElementById('passphrase') as HTMLInputElement;
            const encrypt = (document.getElementById('encrypt-toggle') as HTMLInputElement).checked;

            let token = tokenInput.value.trim();

            if (!token && hasStoredToken()) {
                const passphrase = passphraseInput.value.trim();
                if (!passphrase) {
                    throw new Error('Passphrase required to decrypt stored token');
                }
                const decrypted = await retrieveToken(passphrase);
                if (!decrypted) throw new Error('Failed to decrypt token — wrong passphrase?');
                token = decrypted;
            }

            if (!token) {
                throw new Error('GitHub PAT is required');
            }

            const config = {
                owner: ownerInput.value.trim() || 'srbiz',
                repo: repoInput.value.trim() || 'gittersync-demo-data',
                branch: branchInput.value.trim() || 'main',
                passphrase: passphraseInput.value.trim(),
            };

            saveConfig(config);

            if (encrypt && config.passphrase) {
                await storeToken(token, config.passphrase);
            }

            setState({ view: 'loading' });
            await initializeSync(config, token);

        } catch (err: any) {
            showMessage('error', err.message || 'Initialization failed');
            startBtn.disabled = false;
            startBtn.textContent = '🚀 Start Demo';
        }
    });
}

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}