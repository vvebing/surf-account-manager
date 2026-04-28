import * as vscode from 'vscode';
import type { ManagedAccount } from '../domain/account';
import type { AccountStore } from '../infrastructure/accountStore';
import { BatchAddPanel } from '../presentation/batchAddPanel';

interface AccountCommandArgument {
	accountId?: string;
	account?: {
		id?: string;
	};
}

interface ExportedAccountCredential {
	email: string;
	password: string;
}

function resolveAccountId(argument?: string | AccountCommandArgument): string | undefined {
	if (typeof argument === 'string') {
		return argument;
	}
	if (argument?.accountId) {
		return argument.accountId;
	}
	if (argument?.account?.id) {
		return argument.account.id;
	}
	return undefined;
}

function toExportedCredentials(accounts: readonly ManagedAccount[]): ExportedAccountCredential[] {
	return accounts.map((account) => ({
		email: account.email,
		password: account.password,
	}));
}

async function switchOrLoginAccount(store: AccountStore, argument?: string | AccountCommandArgument): Promise<void> {
	let accountId = resolveAccountId(argument);
	if (!accountId) {
		const items = store.accounts.map((account) => ({
			label: `${account.id === store.currentAccountId ? '$(check) ' : ''}${account.email}`,
			description: account.planName ?? '',
			accountId: account.id,
		}));
		if (items.length === 0) {
			vscode.window.showInformationMessage('暂无账号，请先添加');
			return;
		}
		const selected = await vscode.window.showQuickPick(items, { placeHolder: '选择要登录的账号' });
		if (!selected) {
			return;
		}
		accountId = selected.accountId;
	}

	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: '正在登录账号...' },
			async () => store.switchAccount(accountId!),
		);
		const account = store.currentAccount;
		vscode.window.showInformationMessage(`已登录: ${account?.email ?? accountId}`);
	} catch (error) {
		vscode.window.showErrorMessage(`登录失败: ${String(error)}`);
	}
}

export function registerCommands(
	context: vscode.ExtensionContext,
	store: AccountStore,
	outputChannel: vscode.OutputChannel,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('surf-account-manager.batchAdd', () => {
			BatchAddPanel.show(store, outputChannel);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('surf-account-manager.switchAccount', async (argument?: string | AccountCommandArgument) => {
			await switchOrLoginAccount(store, argument);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('surf-account-manager.loginAccount', async (argument?: string | AccountCommandArgument) => {
			await switchOrLoginAccount(store, argument);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('surf-account-manager.refreshAccount', async (argument?: string | AccountCommandArgument) => {
			let accountId = resolveAccountId(argument);
			if (!accountId) {
				const items = store.accounts.map((account) => ({
					label: account.email,
					description: account.planName ?? '',
					accountId: account.id,
				}));
				const selected = await vscode.window.showQuickPick(items, { placeHolder: '选择要刷新的账号' });
				if (!selected) {
					return;
				}
				accountId = selected.accountId;
			}

			try {
				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: '正在刷新账号额度...' },
					async () => store.refreshAccount(accountId!),
				);
				const account = store.accounts.find((item) => item.id === accountId);
				if (account) {
					const prompt = account.availablePromptCredits !== undefined
						? `Prompt: ${account.availablePromptCredits}/${account.totalPromptCredits ?? '?'}`
						: '';
					const flow = account.availableFlowCredits !== undefined
						? `Flow: ${account.availableFlowCredits}/${account.totalFlowCredits ?? '?'}`
						: '';
					vscode.window.showInformationMessage(`${account.email} 刷新成功 ${[prompt, flow].filter(Boolean).join(' | ')}`);
				}
			} catch (error) {
				vscode.window.showErrorMessage(`刷新失败: ${String(error)}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('surf-account-manager.refreshAll', async () => {
			if (store.accounts.length === 0) {
				vscode.window.showInformationMessage('暂无账号');
				return;
			}

			try {
				const result = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: '正在刷新全部账号额度...',
						cancellable: false,
					},
					async (progress) => store.refreshAllAccounts((current, total) => {
						progress.report({ message: `${current}/${total}`, increment: (1 / total) * 100 });
					}),
				);
				vscode.window.showInformationMessage(`刷新完成: 成功 ${result.success} 个，失败 ${result.failed} 个`);
			} catch (error) {
				vscode.window.showErrorMessage(`刷新失败: ${String(error)}`);
			}
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('surf-account-manager.deleteAccount', async (argument?: string | AccountCommandArgument) => {
			let accountId = resolveAccountId(argument);
			if (!accountId) {
				const items = store.accounts.map((account) => ({
					label: account.email,
					description: account.planName ?? '',
					accountId: account.id,
				}));
				const selected = await vscode.window.showQuickPick(items, { placeHolder: '选择要删除的账号' });
				if (!selected) {
					return;
				}
				accountId = selected.accountId;
			}

			const account = store.accounts.find((item) => item.id === accountId);
			const confirmed = await vscode.window.showWarningMessage(
				`确定删除账号 ${account?.email ?? accountId}？`,
				{ modal: true },
				'删除',
			);
			if (confirmed !== '删除') {
				return;
			}

			await store.deleteAccount(accountId);
			vscode.window.showInformationMessage('账号已删除');
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('surf-account-manager.deleteAll', async () => {
			if (store.accounts.length === 0) {
				vscode.window.showInformationMessage('暂无账号');
				return;
			}

			const confirmed = await vscode.window.showWarningMessage(
				`确定删除全部 ${store.accounts.length} 个账号？`,
				{ modal: true },
				'全部删除',
			);
			if (confirmed !== '全部删除') {
				return;
			}

			await store.deleteAllAccounts();
			vscode.window.showInformationMessage('全部账号已删除');
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('surf-account-manager.exportAll', async () => {
			if (store.accounts.length === 0) {
				vscode.window.showInformationMessage('暂无账号');
				return;
			}

			const accounts = toExportedCredentials(store.accounts);
			await vscode.env.clipboard.writeText(JSON.stringify(accounts, null, 2));
			vscode.window.showInformationMessage(`已复制 ${accounts.length} 个账号密码 JSON`);
		}),
	);
}
