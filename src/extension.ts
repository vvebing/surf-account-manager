// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { registerCommands } from './application/registerCommands';
import { AccountStore } from './infrastructure/accountStore';
import { setAuthLogger } from './infrastructure/windsurfAuth';
import { setDebugLogger, setProxyUrl } from './infrastructure/windsurfApi';
import { AccountListViewProvider } from './presentation/accountListViewProvider';
import { CurrentAccountStatusBar } from './presentation/currentAccountStatusBar';

export let outputChannel: vscode.OutputChannel;
const DEFAULT_AUTO_REFRESH_INTERVAL_MINUTES = 30;

function syncProxyFromSettings(): void {
  const config = vscode.workspace.getConfiguration('surfAccountManager');
  const proxy = config.get<string>('proxy', '').trim();
  setProxyUrl(proxy || undefined);
  outputChannel.appendLine(`[Proxy] ${proxy ? `已设置: ${proxy}` : '未设置 (直连)'}`);
}

class AccountAutoRefresh implements vscode.Disposable {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly configurationSubscription: vscode.Disposable;

  constructor(
    private readonly store: AccountStore,
    private readonly channel: vscode.OutputChannel,
  ) {
    this.configurationSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('surfAccountManager.autoRefreshIntervalMinutes')) {
        this.configure();
      }
    });
    this.configure();
  }

  private configure(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    const config = vscode.workspace.getConfiguration('surfAccountManager');
    const intervalMinutes = config.get<number>('autoRefreshIntervalMinutes', DEFAULT_AUTO_REFRESH_INTERVAL_MINUTES);
    if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
      this.channel.appendLine('[AutoRefresh] 已关闭');
      return;
    }

    const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;
    this.timer = setInterval(() => {
      void this.refresh();
    }, intervalMs);
    this.channel.appendLine(`[AutoRefresh] 每 ${intervalMinutes} 分钟刷新全部账号额度`);
  }

  private async refresh(): Promise<void> {
    if (this.running || this.store.accounts.length === 0) {
      return;
    }

    this.running = true;
    this.channel.appendLine('[AutoRefresh] 开始刷新全部账号额度');
    try {
      const result = await this.store.refreshAllAccounts((current, total) => {
        this.channel.appendLine(`[AutoRefresh] ${current}/${total}`);
      });
      this.channel.appendLine(`[AutoRefresh] 完成: 成功 ${result.success} 个，失败 ${result.failed} 个`);
    } catch (error) {
      this.channel.appendLine(`[AutoRefresh] 失败: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.configurationSubscription.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('Surf Account Manager');
  context.subscriptions.push(outputChannel);

  setDebugLogger((message) => outputChannel.appendLine(message));
  setAuthLogger((message) => outputChannel.appendLine(message));
  outputChannel.appendLine(`[Activate] Surf Account Manager activated at ${new Date().toLocaleString()}`);

  syncProxyFromSettings();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('surfAccountManager.proxy')) {
        syncProxyFromSettings();
      }
    }),
  );

  const store = new AccountStore(context.globalState);
  const accountListViewProvider = new AccountListViewProvider(context.extensionUri, store);
  context.subscriptions.push(
    accountListViewProvider,
    vscode.window.registerWebviewViewProvider('surfAccounts', accountListViewProvider),
    new AccountAutoRefresh(store, outputChannel),
  );
  context.subscriptions.push(new CurrentAccountStatusBar(store));

  registerCommands(context, store, outputChannel);
}

export function deactivate(): void {}
