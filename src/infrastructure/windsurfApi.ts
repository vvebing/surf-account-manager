import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import type { ManagedAccount } from '../domain/account';

const FIREBASE_API_KEY = 'AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY';
const FIREBASE_SIGN_IN_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';
const WINDSURF_REGISTER_API_BASE_URL = 'https://register.windsurf.com';
const WINDSURF_DEFAULT_API_SERVER_URL = 'https://server.codeium.com';
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

function encodeVarint(value: number): Buffer {
	const bytes: number[] = [];
	let current = value;
	while (current > 0x7f) {
		bytes.push((current & 0x7f) | 0x80);
		current >>>= 7;
	}
	bytes.push(current & 0x7f);
	return Buffer.from(bytes);
}

function encodeProtobufString(fieldNumber: number, value: string): Buffer {
	const valueBytes = Buffer.from(value, 'utf8');
	return Buffer.concat([encodeVarint((fieldNumber << 3) | 2), encodeVarint(valueBytes.length), valueBytes]);
}

function decodeProtobufString(buffer: Buffer): string | undefined {
	if (buffer.length < 2 || buffer[0] !== 0x0a) {
		return undefined;
	}
	const length = buffer[1];
	if (buffer.length < length + 2) {
		return undefined;
	}
	return buffer.slice(2, length + 2).toString('utf8');
}

function binaryRequest(url: string, data: Buffer, extraHeaders?: Record<string, string>): Promise<{ status: number; body: string; rawBody?: Buffer }> {
	return doRequest(
		new URL(url),
		data,
		{
			'Content-Type': 'application/proto',
			'connect-protocol-version': '1',
			'User-Agent': APP_USER_AGENT,
			'Content-Length': data.length,
			...extraHeaders,
		},
		resolveProxy(),
	);
}

export interface FirebaseSignInResult {
	idToken: string;
	email: string;
	refreshToken: string;
	localId: string;
}

export async function firebaseSignInWithPassword(email: string, password: string): Promise<FirebaseSignInResult> {
	const response = await jsonRequest(
		`${FIREBASE_SIGN_IN_URL}?key=${FIREBASE_API_KEY}`,
		{ email, password, returnSecureToken: true, clientType: 'CLIENT_TYPE_WEB' },
		{
			'Accept-Language': 'zh-CN,zh;q=0.9',
			'Cache-Control': 'no-cache',
			'X-Client-Version': 'Chrome/JsCore/11.0.0/FirebaseCore-web',
			Referer: 'https://windsurf.com/',
		},
	);

	if (response.status < 200 || response.status >= 300) {
		let errorMessage = response.body;
		try {
			errorMessage = JSON.parse(response.body)?.error?.message ?? response.body;
		} catch {
		}
		const friendlyMessages: Record<string, string> = {
			EMAIL_NOT_FOUND: '邮箱不存在',
			INVALID_PASSWORD: '邮箱或密码错误',
			INVALID_LOGIN_CREDENTIALS: '邮箱或密码错误',
			USER_DISABLED: '账号已被禁用',
			TOO_MANY_ATTEMPTS_TRY_LATER: '尝试次数过多，请稍后再试',
		};
		throw new Error(friendlyMessages[errorMessage] ?? `Firebase 登录失败: ${errorMessage}`);
	}

	const data = JSON.parse(response.body) as FirebaseSignInResult;
	return {
		idToken: data.idToken,
		email: data.email,
		refreshToken: data.refreshToken,
		localId: data.localId,
	};
}

async function postSeatManagement(baseUrl: string, method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
	const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
	const response = await jsonRequest(`${normalizedBaseUrl}/exa.seat_management_pb.SeatManagementService/${method}`, body);
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`请求 Windsurf ${method} 失败: status=${response.status}`);
	}
	return JSON.parse(response.body) as Record<string, unknown>;
}

interface RegisterResult {
	apiKey: string;
	apiServerUrl: string;
	name?: string;
}

async function registerUser(firebaseIdToken: string): Promise<RegisterResult> {
	const result = await postSeatManagement(WINDSURF_REGISTER_API_BASE_URL, 'RegisterUser', { firebase_id_token: firebaseIdToken });
	const apiKey = pickString(result, ['apiKey', 'api_key']);
	if (!apiKey) {
		throw new Error('RegisterUser 响应缺少 apiKey');
	}
	return {
		apiKey,
		apiServerUrl: pickString(result, ['apiServerUrl', 'api_server_url']) ?? WINDSURF_DEFAULT_API_SERVER_URL,
		name: pickString(result, ['name']),
	};
}

async function getOneTimeAuthToken(apiServerUrl: string, firebaseIdToken: string): Promise<string> {
	const requestData = encodeProtobufString(1, firebaseIdToken);
	const urls = [WINDSURF_REGISTER_API_BASE_URL];
	if (apiServerUrl !== WINDSURF_REGISTER_API_BASE_URL) {
		urls.push(apiServerUrl);
	}

	let lastError: Error | undefined;
	for (const baseUrl of urls) {
		const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
		const url = `${normalizedBaseUrl}/exa.seat_management_pb.SeatManagementService/GetOneTimeAuthToken`;
		try {
			const response = await binaryRequest(url, requestData);
			if (response.status >= 200 && response.status < 300 && response.rawBody) {
				let authToken = decodeProtobufString(response.rawBody);
				if (!authToken) {
					authToken = response.rawBody.toString('utf8').match(/[a-zA-Z0-9_-]{35,60}/)?.[0];
				}
				if (authToken && authToken.length >= 30 && authToken.length <= 60) {
					return authToken;
				}
			}
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}

		try {
			const result = await postSeatManagement(baseUrl, 'GetOneTimeAuthToken', { firebase_id_token: firebaseIdToken });
			const authToken = pickString(result, ['authToken', 'auth_token']);
			if (authToken) {
				return authToken;
			}
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}

	throw lastError ?? new Error('GetOneTimeAuthToken 响应缺少 authToken');
}

async function getCurrentUser(apiServerUrl: string, authToken: string): Promise<Record<string, unknown>> {
	return postSeatManagement(apiServerUrl, 'GetCurrentUser', { auth_token: authToken, include_subscription: true });
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
	firebaseIdToken: string,
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
		firebaseIdToken,
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
	const firebase = await firebaseSignInWithPassword(email, password);
	const register = await registerUser(firebase.idToken);

	let authToken: string | undefined;
	try {
		authToken = await getOneTimeAuthToken(register.apiServerUrl, firebase.idToken);
	} catch (error) {
		dbg(`loginWithPassword: authToken FAILED: ${String(error)}`);
	}

	if (authToken && onAuthToken) {
		try {
			await onAuthToken(authToken);
		} catch (error) {
			dbg(`loginWithPassword: authToken injection failed: ${String(error)}`);
		}
	}

	let currentUser: Record<string, unknown> | undefined;
	let planStatus: Record<string, unknown> | undefined;
	let userStatus: Record<string, unknown> | undefined;

	try {
		currentUser = await getCurrentUser(register.apiServerUrl, register.apiKey);
	} catch {
	}
	try {
		planStatus = await getPlanStatus(register.apiServerUrl, register.apiKey);
	} catch {
	}
	try {
		userStatus = await getUserStatusByApiKey(register.apiServerUrl, register.apiKey);
	} catch {
	}

	return buildAccountFromRemote(
		email,
		password,
		firebase.idToken,
		register.apiKey,
		register.apiServerUrl,
		authToken,
		register.name,
		currentUser,
		userStatus,
		planStatus,
	);
}

export async function refreshAccountQuota(account: ManagedAccount): Promise<ManagedAccount> {
	let firebaseIdToken = account.firebaseIdToken;
	if (!firebaseIdToken && account.password) {
		const firebase = await firebaseSignInWithPassword(account.email, account.password);
		firebaseIdToken = firebase.idToken;
	}

	let authToken = account.authToken;
	if (firebaseIdToken) {
		try {
			const register = await registerUser(firebaseIdToken);
			account.apiKey = register.apiKey;
			account.apiServerUrl = register.apiServerUrl;
			try {
				authToken = await getOneTimeAuthToken(register.apiServerUrl, firebaseIdToken);
			} catch {
			}
		} catch {
		}
	}

	let currentUser: Record<string, unknown> | undefined;
	let planStatus: Record<string, unknown> | undefined;
	let userStatus: Record<string, unknown> | undefined;

	if (account.apiKey) {
		try {
			currentUser = await getCurrentUser(account.apiServerUrl, account.apiKey);
		} catch {
		}
		try {
			planStatus = await getPlanStatus(account.apiServerUrl, account.apiKey);
		} catch {
		}
	}
	try {
		userStatus = await getUserStatusByApiKey(account.apiServerUrl, account.apiKey);
	} catch {
	}

	const refreshed = buildAccountFromRemote(
		account.email,
		account.password,
		firebaseIdToken ?? '',
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
