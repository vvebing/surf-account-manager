import * as vscode from 'vscode';
import type { BatchAddResult, ManagedAccount, PasswordCredentialInput } from '../domain/account';
import { loginWithPassword, refreshAccountQuota } from './windsurfApi';
import { activateWindsurfLogin } from './windsurfAuth';

const STORAGE_KEY = 'surf-account-manager.accounts';
const CURRENT_ACCOUNT_KEY = 'surf-account-manager.currentAccountId';

export class AccountStore {
	private accountsState: ManagedAccount[] = [];
	private currentAccountIdState: string | undefined;
	private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
	public readonly onDidChange = this.onDidChangeEmitter.event;

	constructor(private readonly globalState: vscode.Memento) {
		this.load();
	}

	get accounts(): readonly ManagedAccount[] {
		return this.accountsState;
	}

	get currentAccountId(): string | undefined {
		return this.currentAccountIdState;
	}

	get currentAccount(): ManagedAccount | undefined {
		return this.accountsState.find((account) => account.id === this.currentAccountIdState);
	}

	private load(): void {
		this.accountsState = this.globalState.get<ManagedAccount[]>(STORAGE_KEY, []);
		this.currentAccountIdState = this.globalState.get<string>(CURRENT_ACCOUNT_KEY);
	}

	private async save(): Promise<void> {
		await this.globalState.update(STORAGE_KEY, this.accountsState);
		await this.globalState.update(CURRENT_ACCOUNT_KEY, this.currentAccountIdState);
		this.onDidChangeEmitter.fire();
	}

	private upsertAccount(account: ManagedAccount): void {
		const index = this.accountsState.findIndex((item) => item.id === account.id);
		if (index >= 0) {
			account.createdAt = this.accountsState[index].createdAt;
			this.accountsState[index] = account;
			return;
		}

		this.accountsState.push(account);
	}

	async addAccount(email: string, password: string): Promise<ManagedAccount> {
		const account = await loginWithPassword(email.trim(), password, activateWindsurfLogin);
		this.upsertAccount(account);
		this.currentAccountIdState = account.id;
		await this.save();
		return account;
	}

	async batchAddAccounts(credentials: PasswordCredentialInput[]): Promise<BatchAddResult> {
		const accounts: ManagedAccount[] = [];
		const failures: BatchAddResult['failures'] = [];

		for (const credential of credentials) {
			const email = credential.email.trim();
			const password = credential.password;
			if (!email || !password) {
				failures.push({ email, error: '邮箱和密码不能为空', line: credential.sourceLine });
				continue;
			}

			try {
				const account = await loginWithPassword(email, password);
				this.upsertAccount(account);
				accounts.push(account);
			} catch (error) {
				failures.push({
					email,
					error: String(error).replace(/^Error:\s*/, ''),
					line: credential.sourceLine,
				});
			}
		}

		if (accounts.length > 0) {
			const lastAccount = accounts[accounts.length - 1];
			this.currentAccountIdState = lastAccount.id;
			if (lastAccount.authToken) {
				await activateWindsurfLogin(lastAccount.authToken);
			}
		}

		await this.save();
		return {
			successCount: accounts.length,
			failedCount: failures.length,
			failures,
			accounts,
		};
	}

	async switchAccount(accountId: string): Promise<void> {
		const account = this.accountsState.find((item) => item.id === accountId);
		if (!account) {
			throw new Error(`账号不存在: ${accountId}`);
		}

		this.currentAccountIdState = accountId;
		account.lastUsed = Math.floor(Date.now() / 1000);

		if (account.password) {
			try {
				const refreshed = await loginWithPassword(account.email, account.password, activateWindsurfLogin);
				refreshed.createdAt = account.createdAt;
				refreshed.id = account.id;
				const index = this.accountsState.findIndex((item) => item.id === accountId);
				if (index >= 0) {
					this.accountsState[index] = refreshed;
				}
			} catch {
				if (account.authToken) {
					await activateWindsurfLogin(account.authToken);
				}
			}
		} else if (account.authToken) {
			await activateWindsurfLogin(account.authToken);
		}

		await this.save();
	}

	async deleteAccount(accountId: string): Promise<void> {
		this.accountsState = this.accountsState.filter((account) => account.id !== accountId);
		if (this.currentAccountIdState === accountId) {
			this.currentAccountIdState = this.accountsState[0]?.id;
		}
		await this.save();
	}

	async deleteAllAccounts(): Promise<void> {
		this.accountsState = [];
		this.currentAccountIdState = undefined;
		await this.save();
	}

	async refreshAccount(accountId: string): Promise<ManagedAccount> {
		const account = this.accountsState.find((item) => item.id === accountId);
		if (!account) {
			throw new Error(`账号不存在: ${accountId}`);
		}

		try {
			const refreshed = await refreshAccountQuota(account);
			refreshed.quotaQueryError = undefined;
			this.upsertAccount(refreshed);
			await this.save();
			return refreshed;
		} catch (error) {
			account.quotaQueryError = String(error).replace(/^Error:\s*/, '');
			await this.save();
			throw error;
		}
	}

	async refreshAllAccounts(progress?: (current: number, total: number) => void): Promise<{ success: number; failed: number }> {
		let success = 0;
		let failed = 0;
		const total = this.accountsState.length;

		for (let index = 0; index < this.accountsState.length; index += 1) {
			progress?.(index + 1, total);
			const account = this.accountsState[index];
			try {
				const refreshed = await refreshAccountQuota(account);
				refreshed.quotaQueryError = undefined;
				this.upsertAccount(refreshed);
				success += 1;
			} catch (error) {
				account.quotaQueryError = String(error).replace(/^Error:\s*/, '');
				failed += 1;
			}
		}

		await this.save();
		return { success, failed };
	}
}
