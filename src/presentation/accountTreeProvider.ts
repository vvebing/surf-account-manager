import * as vscode from 'vscode';
import type { ManagedAccount } from '../domain/account';
import type { AccountStore } from '../infrastructure/accountStore';

const LOW_QUOTA_THRESHOLD = 20;
const MAX_RECOMMENDED_ACCOUNTS = 3;

type TreeGroupKey = 'current' | 'recommended' | 'available' | 'attention';
type AccountStatusKind = 'current' | 'recommended' | 'healthy' | 'attention' | 'error';

interface AccountViewModel {
	account: ManagedAccount;
	title: string;
	description: string;
	tooltip: vscode.MarkdownString;
	kind: AccountStatusKind;
	iconId: string;
	sortScore: number;
}

interface GroupedAccounts {
	key: TreeGroupKey;
	title: string;
	description: string;
	iconId: string;
	items: AccountViewModel[];
}

class GroupTreeItem extends vscode.TreeItem {
	constructor(public readonly group: GroupedAccounts) {
		super(group.title, vscode.TreeItemCollapsibleState.Expanded);
		this.description = group.description;
		this.tooltip = `${group.title} · ${group.description}`;
		this.contextValue = 'surfAccountGroup';
		this.iconPath = new vscode.ThemeIcon(group.iconId);
	}
}

export class AccountTreeItem extends vscode.TreeItem {
	constructor(public readonly viewModel: AccountViewModel) {
		super(viewModel.title, vscode.TreeItemCollapsibleState.None);

		this.label = viewModel.title;
		this.description = viewModel.description;
		this.tooltip = viewModel.tooltip;
		this.contextValue = 'surfAccount';
		this.iconPath = new vscode.ThemeIcon(viewModel.iconId);
		this.command = {
			command: 'surf-account-manager.switchAccount',
			title: '切换到此账号',
			arguments: [viewModel.account.id],
		};
	}

	get account(): ManagedAccount {
		return this.viewModel.account;
	}
}

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

function truncateEmail(email: string): string {
	if (email.length <= 28) {
		return email;
	}

	const [localPart, domainPart = ''] = email.split('@');
	const compactLocal = localPart.length > 8 ? `${localPart.slice(0, 6)}...` : localPart;
	const compactDomain = domainPart.length > 18 ? `${domainPart.slice(0, 15)}...` : domainPart;
	return compactDomain ? `${compactLocal}@${compactDomain}` : compactLocal;
}

function getPlanLabel(account: ManagedAccount): string | undefined {
	return account.planName ?? account.planType;
}

function buildQuotaSummary(account: ManagedAccount): string | undefined {
	const parts: string[] = [];
	const dailyRemaining = getDailyRemainingPercent(account);
	const weeklyRemaining = getWeeklyRemainingPercent(account);

	if (dailyRemaining !== undefined) {
		parts.push(`今日剩余 ${dailyRemaining}%`);
	}
	if (weeklyRemaining !== undefined) {
		parts.push(`本周剩余 ${weeklyRemaining}%`);
	}
	if (parts.length > 0) {
		return parts.join(' · ');
	}

	if (account.availablePromptCredits !== undefined && account.totalPromptCredits !== undefined) {
		parts.push(`Prompt ${account.availablePromptCredits}/${account.totalPromptCredits}`);
	}
	if (account.availableFlowCredits !== undefined && account.totalFlowCredits !== undefined) {
		parts.push(`Flow ${account.availableFlowCredits}/${account.totalFlowCredits}`);
	}

	return parts.length > 0 ? parts.join(' · ') : undefined;
}

function isLowQuotaAccount(account: ManagedAccount): boolean {
	const dailyRemaining = getDailyRemainingPercent(account);
	const weeklyRemaining = getWeeklyRemainingPercent(account);

	return (dailyRemaining !== undefined && dailyRemaining < LOW_QUOTA_THRESHOLD)
		|| (weeklyRemaining !== undefined && weeklyRemaining < LOW_QUOTA_THRESHOLD);
}

function getAccountSortScore(account: ManagedAccount): number {
	if (account.quotaQueryError) {
		return -1_000_000;
	}

	const dailyRemaining = getDailyRemainingPercent(account) ?? 0;
	const weeklyRemaining = getWeeklyRemainingPercent(account) ?? 0;
	const promptCredits = account.availablePromptCredits ?? 0;
	const flowCredits = account.availableFlowCredits ?? 0;
	const freshness = account.lastRefreshedAt ?? account.lastUsed ?? 0;

	return (dailyRemaining * 1_000)
		+ (weeklyRemaining * 100)
		+ (promptCredits * 10)
		+ flowCredits
		+ freshness / 100_000;
}

function buildAccountDescription(account: ManagedAccount, kind: AccountStatusKind): string {
	const quotaSummary = buildQuotaSummary(account);
	const planLabel = getPlanLabel(account);

	if (kind === 'error') {
		return `状态异常 · ${account.quotaQueryError ?? '请重新刷新'}`;
	}

	if (kind === 'attention') {
		return ['低额度', quotaSummary ?? planLabel ?? '建议谨慎切换'].join(' · ');
	}

	if (kind === 'recommended') {
		return ['建议切换', quotaSummary ?? planLabel ?? '可优先使用'].join(' · ');
	}

	if (kind === 'current') {
		if (account.quotaQueryError) {
			return `当前使用中 · ${account.quotaQueryError}`;
		}
		if (isLowQuotaAccount(account)) {
			return ['当前使用中', '低额度', quotaSummary ?? '建议尽快切换'].join(' · ');
		}
		return ['当前使用中', quotaSummary ?? planLabel ?? '额度待刷新'].join(' · ');
	}

	return [planLabel, quotaSummary].filter(Boolean).join(' · ') || '可用';
}

function getStatusLabel(kind: AccountStatusKind): string {
	if (kind === 'current') {
		return '当前使用中';
	}
	if (kind === 'recommended') {
		return '建议切换';
	}
	if (kind === 'attention') {
		return '低额度';
	}
	if (kind === 'error') {
		return '状态异常';
	}
	return '可用';
}

function getIconId(kind: AccountStatusKind): string {
	if (kind === 'current') {
		return 'account';
	}
	if (kind === 'recommended') {
		return 'star-full';
	}
	if (kind === 'attention') {
		return 'warning';
	}
	if (kind === 'error') {
		return 'error';
	}
	return 'person';
}

function buildTooltip(account: ManagedAccount, kind: AccountStatusKind): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString('', true);
	markdown.isTrusted = true;
	markdown.supportThemeIcons = true;
	markdown.appendMarkdown(`### ${truncateEmail(account.email)}\n\n`);
	markdown.appendMarkdown(`**完整邮箱**: ${account.email}\n\n`);
	markdown.appendMarkdown(`**状态**: ${getStatusLabel(kind)}\n\n`);

	const planLabel = getPlanLabel(account);
	if (planLabel) {
		markdown.appendMarkdown(`**套餐**: ${planLabel}\n\n`);
	}

	markdown.appendMarkdown('---\n\n');

	const dailyRemaining = getDailyRemainingPercent(account);
	if (dailyRemaining !== undefined) {
		const reset = account.dailyResetDate ? `\n\n重置时间: ${account.dailyResetDate}` : '';
		markdown.appendMarkdown(`**今日剩余:**&emsp;&emsp;**${dailyRemaining}%**${reset}\n\n`);
		markdown.appendMarkdown('---\n\n');
	}
	const weeklyRemaining = getWeeklyRemainingPercent(account);
	if (weeklyRemaining !== undefined) {
		const reset = account.weeklyResetDate ? `\n\n重置时间: ${account.weeklyResetDate}` : '';
		markdown.appendMarkdown(`**本周剩余:**&emsp;&emsp;**${weeklyRemaining}%**${reset}\n\n`);
		markdown.appendMarkdown('---\n\n');
	}
	if (account.extraUsageBalance !== undefined) {
		markdown.appendMarkdown(`**额外余额:**&emsp;&emsp;**${account.extraUsageBalance}**\n\n`);
		markdown.appendMarkdown('---\n\n');
	}

	const hasQuota = dailyRemaining !== undefined || weeklyRemaining !== undefined;
	if (!hasQuota) {
		if (account.availablePromptCredits !== undefined) {
			const total = account.totalPromptCredits ?? '?';
			markdown.appendMarkdown(`- Prompt Credits: **${account.availablePromptCredits}** / ${total}\n`);
		}
		if (account.availableFlowCredits !== undefined) {
			const total = account.totalFlowCredits ?? '?';
			markdown.appendMarkdown(`- Flow Credits: **${account.availableFlowCredits}** / ${total}\n`);
		}
	}

	if (account.planEnd) {
		const endDate = new Date(account.planEnd * 1000);
		const daysLeft = Math.max(0, Math.floor((endDate.getTime() - Date.now()) / 86400000));
		markdown.appendMarkdown(`\n- 周期结束: ${endDate.toLocaleDateString()} (剩余 ${daysLeft} 天)\n`);
	}
	if (account.quotaQueryError) {
		markdown.appendMarkdown(`\n\n$(warning) **异常原因**: ${account.quotaQueryError}\n`);
	}
	if (account.lastRefreshedAt) {
		const refreshedAt = new Date(account.lastRefreshedAt * 1000);
		markdown.appendMarkdown(`\n---\n\n*最后刷新: ${refreshedAt.toLocaleString()}*\n`);
	}

	return markdown;
}

function createAccountViewModel(account: ManagedAccount, kind: AccountStatusKind): AccountViewModel {
	return {
		account,
		title: truncateEmail(account.email),
		description: buildAccountDescription(account, kind),
		tooltip: buildTooltip(account, kind),
		kind,
		iconId: getIconId(kind),
		sortScore: getAccountSortScore(account),
	};
}

function buildGroups(accounts: readonly ManagedAccount[], currentAccountId: string | undefined): GroupedAccounts[] {
	const currentAccount = accounts.find((account) => account.id === currentAccountId);
	const remainingAccounts = accounts.filter((account) => account.id !== currentAccountId);
	const healthyAccounts = remainingAccounts.filter((account) => !account.quotaQueryError && !isLowQuotaAccount(account));
	const recommendedIds = new Set(
		healthyAccounts
			.slice()
			.sort((left, right) => getAccountSortScore(right) - getAccountSortScore(left))
			.slice(0, MAX_RECOMMENDED_ACCOUNTS)
			.map((account) => account.id),
	);

	const recommendedItems = remainingAccounts
		.filter((account) => recommendedIds.has(account.id))
		.map((account) => createAccountViewModel(account, 'recommended'))
		.sort((left, right) => right.sortScore - left.sortScore);

	const availableItems = remainingAccounts
		.filter((account) => !recommendedIds.has(account.id) && !account.quotaQueryError && !isLowQuotaAccount(account))
		.map((account) => createAccountViewModel(account, 'healthy'))
		.sort((left, right) => right.sortScore - left.sortScore);

	const attentionItems = remainingAccounts
		.filter((account) => account.quotaQueryError || isLowQuotaAccount(account))
		.map((account) => createAccountViewModel(account, account.quotaQueryError ? 'error' : 'attention'))
		.sort((left, right) => {
			if (left.kind !== right.kind) {
				return left.kind === 'error' ? -1 : 1;
			}
			return left.sortScore - right.sortScore;
		});

	const groups: GroupedAccounts[] = [];

	if (currentAccount) {
		groups.push({
			key: 'current',
			title: '当前账号',
			description: '1 个',
			iconId: 'account',
			items: [createAccountViewModel(currentAccount, 'current')],
		});
	}

	if (recommendedItems.length > 0) {
		groups.push({
			key: 'recommended',
			title: '推荐切换',
			description: `${recommendedItems.length} 个可优先使用`,
			iconId: 'star-empty',
			items: recommendedItems,
		});
	}

	if (availableItems.length > 0) {
		groups.push({
			key: 'available',
			title: '可用账号',
			description: `${availableItems.length} 个`,
			iconId: 'folder',
			items: availableItems,
		});
	}

	if (attentionItems.length > 0) {
		groups.push({
			key: 'attention',
			title: '异常/低额度',
			description: `${attentionItems.length} 个待处理`,
			iconId: 'warning',
			items: attentionItems,
		});
	}

	return groups;
}

type TreeNode = GroupTreeItem | AccountTreeItem;

export class AccountTreeProvider implements vscode.TreeDataProvider<TreeNode> {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeNode | undefined | null | void>();
	public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	constructor(private readonly store: AccountStore) {
		this.store.onDidChange(() => this.refresh());
	}

	refresh(): void {
		this.onDidChangeTreeDataEmitter.fire();
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		return element;
	}

	getChildren(element?: TreeNode): TreeNode[] {
		const groups = buildGroups(this.store.accounts, this.store.currentAccountId);

		if (!element) {
			return groups.map((group) => new GroupTreeItem(group));
		}

		if (element instanceof GroupTreeItem) {
			return element.group.items.map((item) => new AccountTreeItem(item));
		}

		return [];
	}
}
