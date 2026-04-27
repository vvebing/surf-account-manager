import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

let authLog: (message: string) => void = () => {};

export function setAuthLogger(logger: (message: string) => void): void {
	authLog = logger;
}

function getWindsurfGlobalStoragePath(): string {
	if (process.platform === 'win32') {
		const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
		return path.join(appData, 'Windsurf', 'User', 'globalStorage');
	}

	if (process.platform === 'darwin') {
		return path.join(os.homedir(), 'Library', 'Application Support', 'Windsurf', 'User', 'globalStorage');
	}

	return path.join(os.homedir(), '.config', 'Windsurf', 'User', 'globalStorage');
}

export function writeAuthFiles(authToken: string): boolean {
	try {
		const directory = getWindsurfGlobalStoragePath();
		if (!fs.existsSync(directory)) {
			fs.mkdirSync(directory, { recursive: true });
		}

		const authData = JSON.stringify(
			{
				authToken,
				token: authToken,
				api_key: authToken,
				timestamp: Date.now(),
			},
			null,
			2,
		);

		fs.writeFileSync(path.join(directory, 'windsurf-auth.json'), authData, 'utf8');
		fs.writeFileSync(path.join(directory, 'cascade-auth.json'), authData, 'utf8');
		authLog(`[Auth] 认证文件已写入: ${directory}`);
		return true;
	} catch (error) {
		authLog(`[Auth] 写入认证文件失败: ${String(error)}`);
		return false;
	}
}

export async function injectAuthToken(authToken: string): Promise<boolean> {
	try {
		const allCommands = await vscode.commands.getCommands(true);
		const authCommands = allCommands
			.filter((command) => {
				const normalized = command.toLowerCase();
				return (normalized.includes('windsurf') || normalized.includes('cascade'))
					&& (normalized.includes('auth') || normalized.includes('token'));
			})
			.sort((left, right) => {
				const leftPriority = left.toLowerCase().includes('provide') ? 0 : 1;
				const rightPriority = right.toLowerCase().includes('provide') ? 0 : 1;
				return leftPriority - rightPriority;
			});

		authLog(`[Auth] 找到认证命令(排序后): ${authCommands.join(', ') || '(无)'}`);

		for (const command of authCommands) {
			try {
				await vscode.commands.executeCommand(command, authToken);
				authLog(`[Auth] 命令执行成功: ${command} (string)`);
				return true;
			} catch {
				try {
					await vscode.commands.executeCommand(command, { token: authToken, authToken });
					authLog(`[Auth] 命令执行成功: ${command} (object)`);
					return true;
				} catch {
					authLog(`[Auth] 命令执行失败: ${command}`);
				}
			}
		}

		authLog('[Auth] 所有命令注入均失败');
		return false;
	} catch (error) {
		authLog(`[Auth] 注入异常: ${String(error)}`);
		return false;
	}
}

export async function activateWindsurfLogin(authToken: string): Promise<boolean> {
	const fileResult = writeAuthFiles(authToken);
	const injectResult = await injectAuthToken(authToken);
	authLog(`[Auth] 激活结果: 文件=${fileResult}, 注入=${injectResult}`);
	return fileResult || injectResult;
}
