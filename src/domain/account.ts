export interface ManagedAccount {
	id: string;
	email: string;
	password: string;
	displayName: string;
	apiKey: string;
	apiServerUrl: string;
	authToken?: string;
	planName?: string;
	planType?: string;
	availablePromptCredits?: number;
	usedPromptCredits?: number;
	totalPromptCredits?: number;
	availableFlowCredits?: number;
	usedFlowCredits?: number;
	totalFlowCredits?: number;
	planEnd?: number;
	dailyQuotaUsage?: number;
	weeklyQuotaUsage?: number;
	extraUsageBalance?: string;
	dailyResetDate?: string;
	weeklyResetDate?: string;
	userStatus?: Record<string, unknown>;
	planStatus?: Record<string, unknown>;
	lastRefreshedAt?: number;
	createdAt: number;
	lastUsed: number;
	quotaQueryError?: string;
}

export interface BatchAddFailure {
	email: string;
	error: string;
	line?: number;
}

export interface BatchAddResult {
	successCount: number;
	failedCount: number;
	failures: BatchAddFailure[];
	accounts: ManagedAccount[];
}

export interface PasswordCredentialInput {
	email: string;
	password: string;
	sourceLine?: number;
}
