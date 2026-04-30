import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import type { ManagedAccount } from '../domain/account';

const WINDSURF_WEB_BACKEND_API_BASE_URL = 'https://web-backend.windsurf.com';
const WINDSURF_DEVIN_AUTH_BASE_URL = 'https://windsurf.com/_devin-auth';
const WINDSURF_AUTH1_API_SERVER_URL = 'https://server.self-serve.windsurf.com';
const APP_USER_AGENT = 'surf-account-manager-vscode';
const REQUEST_TIMEOUT_MS = 30_000;

let proxyUrl: string | undefined;
let debugLog: (message: string) => void = () => {};

export function setProxyUrl(value: string | undefined): void {
	proxyUrl = value;
}

export function getProxyUrl(): string | undefined {
	return proxyUrl;
}

export function setDebugLogger(logger: (message: string) => void): void {
	debugLog = logger;
}

function dbg(message: string): void {
	debugLog(`[API] ${message}`);
}

function resolveProxy(): string | undefined {
	return proxyUrl || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
}

function connectTunnel(targetProxyUrl: string, targetHost: string, targetPort: number): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const proxy = new URL(targetProxyUrl);
		const proxyHost = proxy.hostname;
		const proxyPort = Number.parseInt(proxy.port, 10) || 80;
		let settled = false;
		const startedAt = Date.now();
		const socket = net.connect(proxyPort, proxyHost, () => {
			dbg(`tunnel: TCP connected (${Date.now() - startedAt}ms), sending CONNECT ${targetHost}:${targetPort}`);
			socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
		});

		socket.setTimeout(REQUEST_TIMEOUT_MS);
		let buffer = '';

		socket.on('data', function onData(chunk: Buffer) {
			if (settled) {
				return;
			}

			buffer += chunk.toString();
			const headerEnd = buffer.indexOf('\r\n\r\n');
			if (headerEnd < 0) {
				return;
			}

			const statusLine = buffer.slice(0, buffer.indexOf('\r\n'));
			const statusCode = Number.parseInt(statusLine.match(/^HTTP\/\d\.\d (\d{3})/)?.[1] ?? '0', 10);
			settled = true;
			socket.removeListener('data', onData);
			socket.setTimeout(0);
			dbg(`tunnel: proxy responded "${statusLine}" (${Date.now() - startedAt}ms)`);

			if (statusCode !== 200) {
				socket.destroy();
				reject(new Error(`代理 CONNECT 失败: ${statusLine} (${targetProxyUrl})`));
				return;
			}

			const trailing = buffer.slice(headerEnd + 4);
			if (trailing.length > 0) {
				socket.unshift(Buffer.from(trailing));
			}

			resolve(socket);
		});

		socket.on('timeout', () => {
			if (settled) {
				return;
			}
			settled = true;
			socket.destroy();
			reject(new Error(`代理连接超时 (${REQUEST_TIMEOUT_MS / 1000}s): ${targetProxyUrl} → ${targetHost}:${targetPort}`));
		});

		socket.on('error', (error) => {
			if (settled) {
				return;
			}
			settled = true;
			reject(new Error(`代理连接失败 (${targetProxyUrl}): ${error.message}`));
		});

		socket.on('close', () => {
			if (settled) {
				return;
			}
			settled = true;
			reject(new Error(`代理连接关闭 (${targetProxyUrl})`));
		});
	});
}

function decodeChunked(raw: string): string {
	const parts: string[] = [];
	let position = 0;

	while (position < raw.length) {
		const lineEnd = raw.indexOf('\r\n', position);
		if (lineEnd < 0) {
			break;
		}
		const size = Number.parseInt(raw.slice(position, lineEnd).trim(), 16);
		if (Number.isNaN(size) || size === 0) {
			break;
		}
		const chunkStart = lineEnd + 2;
		parts.push(raw.slice(chunkStart, chunkStart + size));
		position = chunkStart + size + 2;
	}

	return parts.join('');
}

function doRequest(
	parsedUrl: URL,
	data: string | Buffer,
	headers: Record<string, string | number>,
	proxy: string | undefined,
): Promise<{ status: number; body: string; rawBody?: Buffer }> {
	const isHttps = parsedUrl.protocol === 'https:';
	const targetHost = parsedUrl.hostname;
	const targetPort = Number.parseInt(parsedUrl.port, 10) || (isHttps ? 443 : 80);

	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const options: https.RequestOptions = {
			hostname: targetHost,
			port: targetPort,
			path: parsedUrl.pathname + parsedUrl.search,
			method: 'POST',
			timeout: REQUEST_TIMEOUT_MS,
			headers,
		};

		const handleError = (error: Error): void => {
			const hint = proxy ? ` (代理: ${proxy})` : '';
			reject(new Error(`网络请求失败${hint}: ${error.message}`));
		};

		if (isHttps && proxy) {
			connectTunnel(proxy, targetHost, targetPort)
				.then((rawSocket) => {
					const tlsSocket = tls.connect({ host: targetHost, servername: targetHost, socket: rawSocket });
					tlsSocket.on('error', handleError);
					tlsSocket.on('secureConnect', () => {
						const requestLines = [`POST ${parsedUrl.pathname}${parsedUrl.search} HTTP/1.1`, `Host: ${targetHost}`];
						for (const [key, value] of Object.entries(headers)) {
							requestLines.push(`${key}: ${value}`);
						}
						requestLines.push('Connection: close');
						const headerBlock = `${requestLines.join('\r\n')}\r\n\r\n`;
						if (Buffer.isBuffer(data)) {
							tlsSocket.write(Buffer.concat([Buffer.from(headerBlock, 'utf8'), data]));
						} else {
							tlsSocket.write(headerBlock + data);
						}

						let responseBuffer = '';
						const timer = setTimeout(() => {
							tlsSocket.destroy();
							reject(new Error(`请求超时 (${REQUEST_TIMEOUT_MS / 1000}s): ${targetHost}${parsedUrl.pathname} via proxy ${proxy}`));
						}, REQUEST_TIMEOUT_MS);

						tlsSocket.on('data', (chunk: Buffer) => {
							responseBuffer += chunk.toString();
						});

						tlsSocket.on('end', () => {
							clearTimeout(timer);
							const headerEnd = responseBuffer.indexOf('\r\n\r\n');
							if (headerEnd < 0) {
								reject(new Error('代理响应不完整'));
								return;
							}

							const headerSection = responseBuffer.slice(0, headerEnd);
							const statusLine = headerSection.slice(0, headerSection.indexOf('\r\n'));
							const status = Number.parseInt(statusLine.match(/^HTTP\/\d\.\d (\d{3})/)?.[1] ?? '0', 10);
							let body = responseBuffer.slice(headerEnd + 4);
							if (headerSection.toLowerCase().includes('transfer-encoding: chunked')) {
								body = decodeChunked(body);
							}
							dbg(`request: response ${status} (${Date.now() - startedAt}ms, body ${body.length} bytes)`);
							resolve({ status, body, rawBody: Buffer.from(body, 'binary') });
						});

						tlsSocket.on('error', (error) => {
							clearTimeout(timer);
							handleError(error);
						});
					});
				})
				.catch((error: Error) => {
					reject(error);
				});
			return;
		}

		const request = (isHttps ? https : http).request(options, (response) => {
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('end', () => {
				const rawBody = Buffer.concat(chunks);
				dbg(`request: response ${response.statusCode ?? 0} (${Date.now() - startedAt}ms)`);
				resolve({
					status: response.statusCode ?? 0,
					body: rawBody.toString('utf8'),
					rawBody,
				});
			});
		});

		request.on('timeout', () => {
			request.destroy();
			reject(new Error(`请求超时 (${REQUEST_TIMEOUT_MS / 1000}s): ${targetHost}${parsedUrl.pathname}${proxy ? ` via proxy ${proxy}` : ''}`));
		});
		request.on('error', handleError);
		request.write(data);
		request.end();
	});
}

function jsonRequest(url: string, body: Record<string, unknown>, extraHeaders?: Record<string, string>): Promise<{ status: number; body: string }> {
	const payload = JSON.stringify(body);
	return doRequest(
		new URL(url),
		payload,
		{
			'Content-Type': 'application/json',
			Accept: 'application/json',
			'User-Agent': APP_USER_AGENT,
			'Content-Length': Buffer.byteLength(payload),
			...extraHeaders,
		},
		resolveProxy(),
	);
}

interface Auth1SessionResult {
	sessionToken: string;
	accountId?: string;
	primaryOrgId?: string;
}

function parseErrorMessageFromBody(body: string): string | undefined {
	try {
		const parsed = JSON.parse(body) as Record<string, unknown>;
		const direct = pickString(parsed, ['detail', 'message', 'error']);
		if (direct) {
			return direct;
		}
		const error = parsed.error;
		if (error && typeof error === 'object') {
			return pickString(error as Record<string, unknown>, ['message', 'detail']);
		}
	} catch {
	}
	return undefined;
}

async function loginWithAuth1Password(email: string, password: string): Promise<string> {
	const response = await jsonRequest(
		`${WINDSURF_DEVIN_AUTH_BASE_URL}/password/login`,
		{ email, password },
		{
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
	);
	if (response.status < 200 || response.status >= 300) {
		if (response.status === 401 || response.status === 403) {
			throw new Error('邮箱或密码错误');
		}
		const detail = parseErrorMessageFromBody(response.body) ?? response.body;
		throw new Error(`Devin Auth 登录失败: HTTP ${response.status}${detail ? ` (${detail})` : ''}`);
	}

	const parsed = JSON.parse(response.body) as Record<string, unknown>;
	const token = pickString(parsed, ['token']);
	if (!token) {
		throw new Error('Devin Auth 响应缺少 token');
	}
	return token;
}

function pickAuth1OrgId(payload: Record<string, unknown>): string | undefined {
	const orgs = payload.orgs;
	if (!Array.isArray(orgs)) {
		return undefined;
	}
	const objects = orgs.filter((org): org is Record<string, unknown> => Boolean(org) && typeof org === 'object');
	const preferred = objects.find((org) => {
		if (!pickString(org, ['id'])) {
			return false;
		}
		return org.primary === true || org.isPrimary === true || org.isAdmin === true;
	});
	return pickString(preferred, ['id']) ?? pickString(objects.find((org) => Boolean(pickString(org, ['id']))), ['id']);
}

async function requestAuth1Session(auth1Token: string, orgId: string): Promise<Record<string, unknown>> {
	const response = await jsonRequest(
		`${WINDSURF_WEB_BACKEND_API_BASE_URL}/exa.seat_management_pb.SeatManagementService/WindsurfPostAuth`,
		{ auth1Token, orgId },
		{
			'Content-Type': 'application/json',
			Accept: 'application/json',
			'Connect-Protocol-Version': '1',
		},
	);
	if (response.status < 200 || response.status >= 300) {
		const detail = parseErrorMessageFromBody(response.body) ?? response.body;
		throw new Error(`WindsurfPostAuth 失败: HTTP ${response.status}${detail ? ` (${detail})` : ''}`);
	}
	return JSON.parse(response.body) as Record<string, unknown>;
}

async function exchangeAuth1ForSession(auth1Token: string): Promise<Auth1SessionResult> {
	const first = await requestAuth1Session(auth1Token, '');
	const firstSession = pickString(first, ['sessionToken', 'session_token']);
	const firstAccountId = pickString(first, ['accountId', 'account_id']);
	const firstPrimaryOrgId = pickString(first, ['primaryOrgId', 'primary_org_id']);
	if (firstSession) {
		return {
			sessionToken: firstSession,
			accountId: firstAccountId,
			primaryOrgId: firstPrimaryOrgId,
		};
	}

	const orgId = pickAuth1OrgId(first);
	if (orgId) {
		const second = await requestAuth1Session(auth1Token, orgId);
		const secondSession = pickString(second, ['sessionToken', 'session_token']);
		if (secondSession) {
			return {
				sessionToken: secondSession,
				accountId: pickString(second, ['accountId', 'account_id']) ?? firstAccountId,
				primaryOrgId: pickString(second, ['primaryOrgId', 'primary_org_id']) ?? firstPrimaryOrgId ?? orgId,
			};
		}
	}

	throw new Error('WindsurfPostAuth 未返回 sessionToken');
}

function isAuth1Account(account: ManagedAccount): boolean {
	return account.authToken?.startsWith('devin-session-token$') === true || account.apiKey.startsWith('devin-session-token$');
}

async function postSeatManagement(baseUrl: string, method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
	const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
	const response = await jsonRequest(`${normalizedBaseUrl}/exa.seat_management_pb.SeatManagementService/${method}`, body);
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`请求 Windsurf ${method} 失败: status=${response.status}`);
	}
	return JSON.parse(response.body) as Record<string, unknown>;
}

async function getPlanStatus(apiServerUrl: string, authToken: string): Promise<Record<string, unknown>> {
	return postSeatManagement(apiServerUrl, 'GetPlanStatus', { auth_token: authToken, include_top_up_status: true });
}

function buildUserStatusMetadata(apiKey: string): Record<string, unknown> {
	const operatingSystem = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
	return {
		apiKey,
		ideName: 'Windsurf',
		ideVersion: '1.0.0',
		extensionName: 'codeium.windsurf',
		extensionVersion: '1.0.0',
		locale: 'zh-CN',
		os: operatingSystem,
		disableTelemetry: false,
		sessionId: `vscode-sam-${Date.now()}`,
		requestId: String(Date.now()),
	};
}

async function getUserStatusByApiKey(apiServerUrl: string, apiKey: string): Promise<Record<string, unknown>> {
	return postSeatManagement(apiServerUrl, 'GetUserStatus', { metadata: buildUserStatusMetadata(apiKey) });
}

function pickString(object: Record<string, unknown> | undefined, keys: string[]): string | undefined {
	if (!object) {
		return undefined;
	}
	for (const key of keys) {
		const value = object[key];
		if (typeof value === 'string' && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

function pickNumber(object: Record<string, unknown> | undefined, keys: string[]): number | undefined {
	if (!object) {
		return undefined;
	}
	for (const key of keys) {
		const value = object[key];
		if (typeof value === 'number') {
			return value;
		}
		if (typeof value === 'string') {
			const parsed = Number(value);
			if (!Number.isNaN(parsed)) {
				return parsed;
			}
		}
	}
	return undefined;
}

function hashToId(input: string): string {
	return crypto.createHash('md5').update(input).digest('hex');
}

function parseProtoTimestamp(value: unknown): number | undefined {
	if (typeof value === 'number') {
		return value;
	}
	if (typeof value === 'string') {
		const timestamp = Date.parse(value);
		if (!Number.isNaN(timestamp)) {
			return Math.floor(timestamp / 1000);
		}
	}
	if (value && typeof value === 'object') {
		const seconds = (value as Record<string, unknown>).seconds;
		if (typeof seconds === 'number') {
			return seconds;
		}
		if (typeof seconds === 'string') {
			const parsed = Number(seconds);
			if (!Number.isNaN(parsed)) {
				return parsed;
			}
		}
	}
	return undefined;
}

function buildAccountFromRemote(
	email: string,
	password: string,
	apiKey: string,
	apiServerUrl: string,
	authToken: string | undefined,
	registerName: string | undefined,
	currentUserResponse: Record<string, unknown> | undefined,
	userStatusResponse: Record<string, unknown> | undefined,
	planStatusResponse: Record<string, unknown> | undefined,
): ManagedAccount {
	const currentUser = currentUserResponse?.user as Record<string, unknown> | undefined;
	const userStatus = (userStatusResponse?.userStatus ?? userStatusResponse) as Record<string, unknown> | undefined;
	const userStatusPlanStatus = userStatus?.planStatus as Record<string, unknown> | undefined;
	const planStatus = planStatusResponse ?? userStatusPlanStatus ?? userStatus;
	const planInfo = (userStatusPlanStatus?.planInfo ?? planStatus?.planInfo ?? userStatusResponse?.planInfo) as Record<string, unknown> | undefined;
	const name = pickString(currentUser, ['name']) ?? pickString(userStatus, ['name']) ?? registerName;
	const emailFromApi = pickString(currentUser, ['email']) ?? pickString(userStatus, ['email']);
	const username = pickString(currentUser, ['username']) ?? pickString(userStatus, ['username']);
	const userId = pickString(currentUser, ['id']) ?? pickString(userStatus, ['id']);
	const loginSeed = username ?? (emailFromApi ? emailFromApi.split('@')[0] : undefined) ?? name ?? 'windsurf_user';
	const displayName = emailFromApi ?? loginSeed;
	const id = `windsurf_${hashToId(`${loginSeed}:${userId ?? emailFromApi ?? email}`)}`;
	const creditSource = userStatusPlanStatus ?? planStatus;
	const availablePromptCredits = pickNumber(creditSource, ['availablePromptCredits', 'available_prompt_credits']);
	const usedPromptCredits = pickNumber(creditSource, ['usedPromptCredits', 'used_prompt_credits']);
	const availableFlowCredits = pickNumber(creditSource, ['availableFlowCredits', 'available_flow_credits']);
	const usedFlowCredits = pickNumber(creditSource, ['usedFlowCredits', 'used_flow_credits']);
	const totalPromptCredits = pickNumber(planInfo, ['monthlyPromptCredits', 'monthly_prompt_credits'])
		?? (availablePromptCredits !== undefined ? availablePromptCredits + (usedPromptCredits ?? 0) : undefined);
	const totalFlowCredits = pickNumber(planInfo, ['monthlyFlowCredits', 'monthly_flow_credits'])
		?? (availableFlowCredits !== undefined ? availableFlowCredits + (usedFlowCredits ?? 0) : undefined);
	const planEnd = parseProtoTimestamp(creditSource?.planEnd);
	const planName = pickString(planInfo, ['planName', 'plan_name']) ?? pickString(planInfo, ['teamsTier', 'teams_tier']);
	const hasQuotaSystem = Boolean(creditSource && (
		'weeklyQuotaRemainingPercent' in creditSource
		|| 'dailyQuotaRemainingPercent' in creditSource
		|| 'dailyQuotaResetAtUnix' in creditSource
		|| 'weeklyQuotaResetAtUnix' in creditSource
	));
	const dailyRemaining = pickNumber(creditSource, ['dailyQuotaRemainingPercent', 'dailyQuotaRemainingPercentage']);
	const weeklyRemaining = pickNumber(creditSource, ['weeklyQuotaRemainingPercent', 'weeklyQuotaRemainingPercentage']);
	const dailyQuotaUsage = hasQuotaSystem ? 100 - (dailyRemaining ?? 0) : undefined;
	const weeklyQuotaUsage = hasQuotaSystem ? 100 - (weeklyRemaining ?? 0) : undefined;
	const topUpStatus = creditSource?.topUpStatus as Record<string, unknown> | undefined;
	const topUpBalance = pickNumber(topUpStatus, ['balance', 'currentBalance', 'current_balance']);
	const extraUsageBalance = topUpBalance !== undefined ? `$${(topUpBalance / 100).toFixed(2)}` : undefined;
	const dailyResetUnix = pickNumber(creditSource, ['dailyQuotaResetAtUnix', 'dailyQuotaResetTime']);
	const weeklyResetUnix = pickNumber(creditSource, ['weeklyQuotaResetAtUnix', 'weeklyQuotaResetTime']);
	const dailyResetDate = dailyResetUnix ? new Date(dailyResetUnix * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : undefined;
	const weeklyResetDate = weeklyResetUnix ? new Date(weeklyResetUnix * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : undefined;
	const now = Math.floor(Date.now() / 1000);

	return {
		id,
		email: emailFromApi ?? email,
		password,
		displayName,
		apiKey,
		apiServerUrl,
		authToken,
		planName,
		planType: planName,
		availablePromptCredits,
		usedPromptCredits,
		totalPromptCredits,
		availableFlowCredits,
		usedFlowCredits,
		totalFlowCredits,
		planEnd,
		dailyQuotaUsage,
		weeklyQuotaUsage,
		extraUsageBalance,
		dailyResetDate,
		weeklyResetDate,
		userStatus: userStatusResponse,
		planStatus: planStatusResponse,
		lastRefreshedAt: now,
		createdAt: now,
		lastUsed: now,
	};
}

export async function loginWithPassword(
	email: string,
	password: string,
	onAuthToken?: (authToken: string) => Promise<unknown>,
): Promise<ManagedAccount> {
	dbg(`loginWithPassword: ${email}`);
	const auth1Token = await loginWithAuth1Password(email, password);
	const session = await exchangeAuth1ForSession(auth1Token);
	const authToken = session.sessionToken;

	if (onAuthToken) {
		try {
			await onAuthToken(authToken);
		} catch (error) {
			dbg(`loginWithPassword: Auth1 authToken injection failed: ${String(error)}`);
		}
	}

	let planStatus: Record<string, unknown> | undefined;
	let userStatus: Record<string, unknown> | undefined;
	try {
		planStatus = await getPlanStatus(WINDSURF_AUTH1_API_SERVER_URL, authToken);
	} catch {
	}
	try {
		userStatus = await getUserStatusByApiKey(WINDSURF_AUTH1_API_SERVER_URL, authToken);
	} catch {
	}

	return buildAccountFromRemote(
		email,
		password,
		authToken,
		WINDSURF_AUTH1_API_SERVER_URL,
		authToken,
		email,
		undefined,
		userStatus,
		planStatus,
	);
}

export async function refreshAccountQuota(account: ManagedAccount): Promise<ManagedAccount> {
	const authToken = account.authToken;
	let currentUser: Record<string, unknown> | undefined;
	let planStatus: Record<string, unknown> | undefined;
	let userStatus: Record<string, unknown> | undefined;

	if (isAuth1Account(account)) {
		try {
			planStatus = await getPlanStatus(account.apiServerUrl || WINDSURF_AUTH1_API_SERVER_URL, authToken ?? account.apiKey);
		} catch {
		}
		try {
			userStatus = await getUserStatusByApiKey(account.apiServerUrl || WINDSURF_AUTH1_API_SERVER_URL, authToken ?? account.apiKey);
		} catch {
		}
	}
	if (!userStatus) {
		try {
			userStatus = await getUserStatusByApiKey(account.apiServerUrl, account.apiKey);
		} catch {
		}
	}

	const refreshed = buildAccountFromRemote(
		account.email,
		account.password,
		account.apiKey,
		account.apiServerUrl,
		authToken,
		account.displayName,
		currentUser,
		userStatus,
		planStatus,
	);
	refreshed.id = account.id;
	refreshed.createdAt = account.createdAt;
	refreshed.password = account.password;
	refreshed.lastRefreshedAt = Math.floor(Date.now() / 1000);
	return refreshed;
}
