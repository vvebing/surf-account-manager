import * as vscode from 'vscode';
import type { ManagedAccount } from '../domain/account';
import type { AccountStore } from '../infrastructure/accountStore';

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

function isLowQuotaAccount(account: ManagedAccount): boolean {
	const dailyRemaining = getDailyRemainingPercent(account);
	const weeklyRemaining = getWeeklyRemainingPercent(account);

	return (dailyRemaining !== undefined && dailyRemaining < LOW_QUOTA_THRESHOLD)
		|| (weeklyRemaining !== undefined && weeklyRemaining < LOW_QUOTA_THRESHOLD);
}

function truncateEmail(email: string): string {
	if (email.length <= 18) {
		return email;
	}

	const [localPart, domainPart = ''] = email.split('@');
	const compactLocal = localPart.length > 6 ? `${localPart.slice(0, 6)}...` : localPart;
	const compactDomain = domainPart.length > 10 ? `${domainPart.slice(0, 10)}...` : domainPart;
	return compactDomain ? `${compactLocal}@${compactDomain}` : compactLocal;
}

function getQuotaSummary(account: ManagedAccount): string {
	const parts: string[] = [];
	const dailyRemaining = getDailyRemainingPercent(account);
	const weeklyRemaining = getWeeklyRemainingPercent(account);

	if (dailyRemaining !== undefined) {
		parts.push(`日${dailyRemaining}%`);
	}
	if (weeklyRemaining !== undefined) {
		parts.push(`周${weeklyRemaining}%`);
	}
	if (parts.length > 0) {
		return parts.join(' · ');
	}

	if (account.availablePromptCredits !== undefined && account.totalPromptCredits !== undefined) {
		parts.push(`P${account.availablePromptCredits}/${account.totalPromptCredits}`);
	}
	if (account.availableFlowCredits !== undefined && account.totalFlowCredits !== undefined) {
		parts.push(`F${account.availableFlowCredits}/${account.totalFlowCredits}`);
	}

	return parts.length > 0 ? parts.join(' · ') : '额度待刷新';
}

function getPlanLabel(account: ManagedAccount): string | undefined {
	return account.planName ?? account.planType;
}

function buildTooltip(account: ManagedAccount, statusLabel: string): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString('', true);
	markdown.isTrusted = true;
	markdown.supportThemeIcons = true;
	markdown.appendMarkdown(`### Surf 当前账号\n\n`);
	markdown.appendMarkdown(`**状态**: ${statusLabel}\n\n`);
	markdown.appendMarkdown(`**邮箱**: ${account.email}\n\n`);

	const planLabel = getPlanLabel(account);
	if (planLabel) {
		markdown.appendMarkdown(`**套餐**: ${planLabel}\n\n`);
	}

	markdown.appendMarkdown(`**额度摘要**: ${getQuotaSummary(account)}\n\n`);

	if (account.quotaQueryError) {
		markdown.appendMarkdown(`$(warning) **异常原因**: ${account.quotaQueryError}\n\n`);
	}
	if (account.lastRefreshedAt) {
		const refreshedAt = new Date(account.lastRefreshedAt * 1000);
		markdown.appendMarkdown(`*最后刷新: ${refreshedAt.toLocaleString()}*\n\n`);
	}

	markdown.appendMarkdown('点击可快速切换账号。');
	return markdown;
}

export class CurrentAccountStatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private readonly storeSubscription: vscode.Disposable;

	constructor(private readonly store: AccountStore) {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
		this.storeSubscription = this.store.onDidChange(() => this.render());
		this.render();
		this.item.show();
	}

	private render(): void {
		const currentAccount = this.store.currentAccount;
		if (!currentAccount) {
			this.item.text = '$(person-add) Surf: 添加账号';
			this.item.tooltip = '当前没有可用账号，点击添加账号';
			this.item.command = 'surf-account-manager.batchAdd';
			this.item.backgroundColor = undefined;
			this.item.color = undefined;
			return;
		}

		const label = truncateEmail(currentAccount.email);
		const quotaSummary = getQuotaSummary(currentAccount);
		const isLowQuota = isLowQuotaAccount(currentAccount);
		const hasError = Boolean(currentAccount.quotaQueryError);

		if (hasError) {
			this.item.text = `$(error) Surf: ${label} · 异常`;
			this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
			this.item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
			this.item.tooltip = buildTooltip(currentAccount, '状态异常');
		} else if (isLowQuota) {
			this.item.text = `$(warning) Surf: ${label} · ${quotaSummary}`;
			this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			this.item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
			this.item.tooltip = buildTooltip(currentAccount, '低额度');
		} else {
			this.item.text = `$(account) Surf: ${label} · ${quotaSummary}`;
			this.item.backgroundColor = undefined;
			this.item.color = undefined;
			this.item.tooltip = buildTooltip(currentAccount, '当前使用中');
		}

		this.item.command = 'surf-account-manager.switchAccount';
	}

	dispose(): void {
		this.storeSubscription.dispose();
		this.item.dispose();
	}
}
