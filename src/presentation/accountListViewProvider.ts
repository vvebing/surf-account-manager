import * as vscode from 'vscode';
import type { ManagedAccount } from '../domain/account';
import type { AccountStore } from '../infrastructure/accountStore';

interface WebviewAccount {
	id: string;
	email: string;
	planLabel?: string;
	statusLabel: string;
	current: boolean;
	hasError: boolean;
	error?: string;
	dailyRemaining?: number;
	weeklyRemaining?: number;
	dailyResetDate?: string;
	weeklyResetDate?: string;
}

const LOW_QUOTA_THRESHOLD = 20;

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, Math.round(value)));
}

function getDailyRemainingPercent(account: ManagedAccount): number | undefined {
	if (account.dailyQuotaUsage === undefined) {
		return undefined;
	}

	return clampPercent(100 - account.dailyQuotaUsage);
}

function getWeeklyRemainingPercent(account: ManagedAccount): number | undefined {
	if (account.weeklyQuotaUsage === undefined) {
		return undefined;
	}

	return clampPercent(100 - account.weeklyQuotaUsage);
}

function getPlanLabel(account: ManagedAccount): string | undefined {
	return account.planName ?? account.planType;
}

function isLowQuotaAccount(account: ManagedAccount): boolean {
	const dailyRemaining = getDailyRemainingPercent(account);
	const weeklyRemaining = getWeeklyRemainingPercent(account);

	return (dailyRemaining !== undefined && dailyRemaining < LOW_QUOTA_THRESHOLD)
		|| (weeklyRemaining !== undefined && weeklyRemaining < LOW_QUOTA_THRESHOLD);
}

function getSortScore(account: ManagedAccount): number {
	if (account.quotaQueryError) {
		return -1_000_000;
	}

	return ((getDailyRemainingPercent(account) ?? 0) * 1_000)
		+ ((getWeeklyRemainingPercent(account) ?? 0) * 100)
		+ ((account.availablePromptCredits ?? 0) * 10)
		+ (account.availableFlowCredits ?? 0)
		+ ((account.lastRefreshedAt ?? account.lastUsed ?? 0) / 100_000);
}

function getStatusLabel(account: ManagedAccount, isCurrent: boolean): string {
	if (account.quotaQueryError) {
		return '异常';
	}
	if (isCurrent) {
		return isLowQuotaAccount(account) ? '当前 · 低额度' : '当前';
	}
	if (isLowQuotaAccount(account)) {
		return '低额度';
	}
	return '可用';
}

function toWebviewAccounts(accounts: readonly ManagedAccount[], currentAccountId: string | undefined): WebviewAccount[] {
	return accounts
		.slice()
		.sort((left, right) => {
			if (left.id === currentAccountId) {
				return -1;
			}
			if (right.id === currentAccountId) {
				return 1;
			}
			return getSortScore(right) - getSortScore(left);
		})
		.map((account) => {
			const current = account.id === currentAccountId;
			return {
				id: account.id,
				email: account.email,
				planLabel: getPlanLabel(account),
				statusLabel: getStatusLabel(account, current),
				current,
				hasError: Boolean(account.quotaQueryError),
				error: account.quotaQueryError,
				dailyRemaining: getDailyRemainingPercent(account),
				weeklyRemaining: getWeeklyRemainingPercent(account),
				dailyResetDate: account.dailyResetDate,
				weeklyResetDate: account.weeklyResetDate,
			};
		});
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let index = 0; index < 32; index += 1) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

export class AccountListViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private messageSubscription: vscode.Disposable | undefined;
	private readonly storeSubscription: vscode.Disposable;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly store: AccountStore,
	) {
		this.storeSubscription = this.store.onDidChange(() => this.render());
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);

		this.messageSubscription?.dispose();
		this.messageSubscription = webviewView.webview.onDidReceiveMessage((message: unknown) => {
			void this.handleMessage(message);
		});
	}

	private async handleMessage(message: unknown): Promise<void> {
		if (!message || typeof message !== 'object') {
			return;
		}

		const payload = message as { command?: string; accountId?: string };
		if (payload.command === 'ready') {
			this.render();
			return;
		}
		if (payload.command === 'batchAdd') {
			await vscode.commands.executeCommand('surf-account-manager.batchAdd');
			return;
		}
		if (payload.command === 'refreshAll') {
			await vscode.commands.executeCommand('surf-account-manager.refreshAll');
			return;
		}
		if (payload.command === 'refreshAccount' && payload.accountId) {
			await vscode.commands.executeCommand('surf-account-manager.refreshAccount', payload.accountId);
			return;
		}
		if (payload.command === 'loginAccount' && payload.accountId) {
			await vscode.commands.executeCommand('surf-account-manager.loginAccount', payload.accountId);
		}
	}

	private render(): void {
		void this.view?.webview.postMessage({
			command: 'render',
			accounts: toWebviewAccounts(this.store.accounts, this.store.currentAccountId),
			currentAccountId: this.store.currentAccountId,
		});
	}

	private getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		:root {
			--border: var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
			--muted: var(--vscode-descriptionForeground);
			--card-bg: var(--vscode-sideBar-background);
			--button-bg: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
			--button-fg: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
			--button-hover: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
			--accent: var(--vscode-progressBar-background, var(--vscode-button-background));
			--warning: var(--vscode-editorWarning-foreground, #cca700);
			--error: var(--vscode-editorError-foreground, #f14c4c);
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			padding: 10px;
			color: var(--vscode-foreground);
			background: var(--vscode-sideBar-background);
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
		}
		button {
			border: 0;
			border-radius: 4px;
			padding: 4px 10px;
			color: var(--button-fg);
			background: var(--button-bg);
			cursor: pointer;
			font: inherit;
		}
		button:hover { background: var(--button-hover); }
		.toolbar {
			display: flex;
			gap: 8px;
			margin-bottom: 10px;
		}
		.account-list {
			display: grid;
			gap: 10px;
		}
		.account-card {
			border: 1px solid var(--border);
			border-radius: 6px;
			background: var(--card-bg);
			padding: 10px;
		}
		.account-title {
			display: flex;
			align-items: baseline;
			justify-content: space-between;
			gap: 8px;
			margin-bottom: 6px;
		}
		.email {
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-weight: 600;
		}
		.status {
			flex: 0 0 auto;
			color: var(--muted);
			font-size: 12px;
		}
		.status.error { color: var(--error); }
		.status.warning { color: var(--warning); }
		.actions {
			display: flex;
			gap: 8px;
			margin-bottom: 10px;
		}
		.quota-row {
			display: grid;
			grid-template-columns: minmax(118px, 140px) minmax(48px, 1fr) auto;
			align-items: center;
			gap: 8px;
			margin-top: 7px;
		}
		.quota-label {
			color: var(--muted);
			font-size: 12px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.progress {
			height: 7px;
			border-radius: 999px;
			overflow: hidden;
			background: var(--vscode-input-background);
			border: 1px solid var(--border);
		}
		.progress-fill {
			height: 100%;
			width: 0;
			background: var(--accent);
			transition: width 120ms ease-out;
		}
		.progress-fill.low { background: var(--error); }
		.progress-fill.medium { background: var(--warning); }
		.quota-value {
			min-width: 36px;
			text-align: right;
			font-size: 12px;
		}
		.error-message {
			color: var(--error);
			font-size: 12px;
			margin-top: 8px;
		}
		.empty {
			border: 1px dashed var(--border);
			border-radius: 6px;
			padding: 14px;
			color: var(--muted);
		}
	</style>
</head>
<body>
	<div class="toolbar">
		<button type="button" id="refresh-all">刷新全部</button>
		<button type="button" id="add-account">添加帐号</button>
	</div>
	<div id="root"></div>
	<script nonce="${nonce}">
		(() => {
			const vscode = acquireVsCodeApi();
			const root = document.getElementById('root');
			const refreshAllButton = document.getElementById('refresh-all');
			const addAccountButton = document.getElementById('add-account');
			let accounts = [];

			function createElement(tag, className, text) {
				const element = document.createElement(tag);
				if (className) {
					element.className = className;
				}
				if (text !== undefined) {
					element.textContent = text;
				}
				return element;
			}

			function getLevel(percent) {
				if (percent === undefined) {
					return '';
				}
				if (percent < 20) {
					return ' low';
				}
				if (percent < 50) {
					return ' medium';
				}
				return '';
			}

			function compactResetDate(resetDate) {
				if (!resetDate) {
					return '';
				}
				const parsed = new Date(resetDate);
				if (!Number.isNaN(parsed.getTime())) {
					return new Intl.DateTimeFormat('zh-CN', {
						month: '2-digit',
						day: '2-digit',
						hour: '2-digit',
						minute: '2-digit',
						hour12: false
					}).format(parsed);
				}
				return resetDate
					.replace(/^\\d{4}[/-]/, '')
					.replace(/:\\d{2}$/, '')
					.replace(/\\s+/g, ' ');
			}

			function appendQuotaRow(parent, label, percent, resetDate) {
				const row = createElement('div', 'quota-row');
				const resetLabel = compactResetDate(resetDate);
				const labelElement = createElement('div', 'quota-label', resetLabel ? label + '（' + resetLabel + '）' : label);
				const progress = createElement('div', 'progress');
				const fill = createElement('div', 'progress-fill' + getLevel(percent));
				const value = createElement('div', 'quota-value', percent === undefined ? '待刷新' : percent + '%');

				if (resetDate) {
					row.title = '重置时间: ' + resetDate;
				}
				if (percent !== undefined) {
					fill.style.width = percent + '%';
				}

				progress.appendChild(fill);
				row.appendChild(labelElement);
				row.appendChild(progress);
				row.appendChild(value);
				parent.appendChild(row);
			}

			function appendAccount(parent, account) {
				const card = createElement('section', 'account-card');
				const title = createElement('div', 'account-title');
				const email = createElement('div', 'email', account.email);
				const statusClass = account.hasError ? ' error' : account.statusLabel.includes('低额度') ? ' warning' : '';
				const statusText = account.planLabel ? account.statusLabel + ' · ' + account.planLabel : account.statusLabel;
				const status = createElement('div', 'status' + statusClass, statusText);
				const actions = createElement('div', 'actions');
				const refresh = createElement('button', '', '刷新');
				const login = createElement('button', '', '登录');

				refresh.type = 'button';
				login.type = 'button';
				refresh.title = '刷新帐号额度';
				login.title = '登录此帐号';
				refresh.addEventListener('click', () => vscode.postMessage({ command: 'refreshAccount', accountId: account.id }));
				login.addEventListener('click', () => vscode.postMessage({ command: 'loginAccount', accountId: account.id }));

				title.appendChild(email);
				title.appendChild(status);
				actions.appendChild(refresh);
				actions.appendChild(login);
				card.appendChild(title);
				card.appendChild(actions);
				appendQuotaRow(card, '今日', account.dailyRemaining, account.dailyResetDate);
				appendQuotaRow(card, '本周', account.weeklyRemaining, account.weeklyResetDate);

				if (account.error) {
					card.appendChild(createElement('div', 'error-message', account.error));
				}

				parent.appendChild(card);
			}

			function render() {
				root.replaceChildren();
				if (accounts.length === 0) {
					const empty = createElement('div', 'empty', '暂无帐号');
					root.appendChild(empty);
					return;
				}

				const list = createElement('div', 'account-list');
				accounts.forEach((account) => appendAccount(list, account));
				root.appendChild(list);
			}

			refreshAllButton.addEventListener('click', () => vscode.postMessage({ command: 'refreshAll' }));
			addAccountButton.addEventListener('click', () => vscode.postMessage({ command: 'batchAdd' }));
			window.addEventListener('message', (event) => {
				const message = event.data;
				if (message.command === 'render') {
					accounts = message.accounts || [];
					render();
				}
			});
			vscode.postMessage({ command: 'ready' });
		})();
	</script>
</body>
</html>`;
	}

	dispose(): void {
		this.storeSubscription.dispose();
		this.messageSubscription?.dispose();
	}
}
