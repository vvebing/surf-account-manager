import * as vscode from 'vscode';
import type { PasswordCredentialInput } from '../domain/account';
import type { AccountStore } from '../infrastructure/accountStore';
import { getProxyUrl } from '../infrastructure/windsurfApi';

const PANEL_STYLES = `
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --input-bg: var(--vscode-input-background);
    --input-border: var(--vscode-input-border, #444);
    --input-fg: var(--vscode-input-foreground);
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
    --error: var(--vscode-errorForeground, #f44);
    --success: #4caf50;
    --warning: #ff9800;
    --border: var(--vscode-panel-border, #444);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); background: var(--bg); color: var(--fg); padding: 20px; line-height: 1.6; }
  h2 { margin-bottom: 16px; font-size: 18px; }
  .tabs { display: flex; gap: 0; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
  .tab { padding: 8px 20px; cursor: pointer; border: none; background: transparent; color: var(--fg); font-size: 14px; border-bottom: 2px solid transparent; opacity: 0.7; }
  .tab:hover { opacity: 1; }
  .tab.active { border-bottom-color: var(--btn-bg); opacity: 1; font-weight: 600; }
  .panel { display: none; }
  .panel.active { display: block; }
  .form-group { margin-bottom: 14px; }
  label { display: block; margin-bottom: 4px; font-size: 13px; font-weight: 500; }
  input[type="text"], input[type="password"], input[type="email"] { width: 100%; padding: 8px 10px; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); border-radius: 4px; font-size: 13px; }
  textarea { width: 100%; min-height: 200px; padding: 8px 10px; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); border-radius: 4px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; resize: vertical; }
  .btn { padding: 8px 20px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500; }
  .btn-primary { background: var(--btn-bg); color: var(--btn-fg); }
  .btn-primary:hover { background: var(--btn-hover); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .format-options { display: flex; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  .format-options label { display: flex; align-items: center; gap: 4px; font-weight: 400; cursor: pointer; }
  .format-options input[type="radio"] { margin: 0; }
  .delimiter-options { display: flex; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
  .delimiter-options label { display: flex; align-items: center; gap: 4px; font-weight: 400; cursor: pointer; font-size: 12px; }
  .message { margin-top: 14px; padding: 10px 14px; border-radius: 4px; font-size: 13px; display: none; }
  .message.show { display: block; }
  .message.error { background: rgba(244,67,54,0.12); color: var(--error); border: 1px solid rgba(244,67,54,0.3); }
  .message.success { background: rgba(76,175,80,0.12); color: var(--success); border: 1px solid rgba(76,175,80,0.3); }
  .message.partial { background: rgba(255,152,0,0.12); color: var(--warning); border: 1px solid rgba(255,152,0,0.3); }
  .message.loading { background: rgba(33,150,243,0.12); color: #2196f3; border: 1px solid rgba(33,150,243,0.3); }
  .example { margin-top: 8px; padding: 8px 10px; background: rgba(128,128,128,0.1); border-radius: 4px; font-size: 11px; white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); color: var(--fg); opacity: 0.7; }
  .example-label { font-size: 11px; opacity: 0.6; margin-bottom: 4px; }
  .custom-delim-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  .custom-delim-row input { width: 120px; }
`;

const PANEL_MARKUP = `
  <h2>Surf 账号管理</h2>
  <div class="tabs">
    <button class="tab" data-panel="single">单个添加</button>
    <button class="tab active" data-panel="batch">批量添加</button>
  </div>
  <div id="panel-single" class="panel">
    <div class="form-group">
      <label for="email">邮箱</label>
      <input type="email" id="email" placeholder="user@example.com" />
    </div>
    <div class="form-group">
      <label for="password">密码</label>
      <input type="password" id="password" placeholder="请输入密码" />
    </div>
    <button class="btn btn-primary" id="btn-single-add">登录并添加</button>
  </div>
  <div id="panel-batch" class="panel active">
    <div class="format-options">
      <label><input type="radio" name="batchFormat" value="json" checked /> JSON 格式</label>
      <label><input type="radio" name="batchFormat" value="text" /> 文本格式</label>
    </div>
    <div id="delimiter-section" style="display:none;">
      <label style="font-size:12px;margin-bottom:6px;">分隔符</label>
      <div class="delimiter-options">
        <label><input type="radio" name="delimiter" value="tab" checked /> Tab</label>
        <label><input type="radio" name="delimiter" value="space" /> 空格</label>
        <label><input type="radio" name="delimiter" value="comma" /> 逗号</label>
        <label><input type="radio" name="delimiter" value="pipe" /> 竖线 |</label>
        <label><input type="radio" name="delimiter" value="dash" /> ----</label>
        <label><input type="radio" name="delimiter" value="custom" /> 自定义</label>
      </div>
      <div id="custom-delim-row" class="custom-delim-row" style="display:none;">
        <label style="font-size:12px;">自定义分隔符:</label>
        <input type="text" id="custom-delimiter" placeholder="::" />
      </div>
    </div>
    <div class="form-group">
      <label for="batch-input">批量输入</label>
      <textarea id="batch-input" placeholder="粘贴 JSON 数组，每项包含 email 和 password"></textarea>
    </div>
    <div class="example-label">示例：</div>
    <div class="example" id="batch-example">[
  { "email": "user1@example.com", "password": "password123" },
  { "email": "user2@example.com", "password": "abc456789" }
]</div>
    <div style="margin-top:14px;">
      <button class="btn btn-primary" id="btn-batch-add">批量导入</button>
    </div>
  </div>
  <div class="message" id="message-box"></div>
`;

const PANEL_SCRIPT = String.raw`
(() => {
  const vscode = acquireVsCodeApi();
  const byId = (id) => document.getElementById(id);
  const query = (selector) => document.querySelector(selector);
  const queryAll = (selector) => Array.from(document.querySelectorAll(selector));

  const tabs = queryAll('.tab');
  const panels = queryAll('.panel');
  const batchFormatRadios = queryAll('input[name="batchFormat"]');
  const delimiterRadios = queryAll('input[name="delimiter"]');
  const delimiterSection = byId('delimiter-section');
  const customDelimiterRow = byId('custom-delim-row');
  const batchInput = byId('batch-input');
  const batchExample = byId('batch-example');
  const btnSingle = byId('btn-single-add');
  const btnBatch = byId('btn-batch-add');
  const messageBox = byId('message-box');
  const emailInput = byId('email');
  const passwordInput = byId('password');
  const customDelimiterInput = byId('custom-delimiter');

  const jsonExample = JSON.stringify([
    { email: 'user1@example.com', password: 'password123' },
    { email: 'user2@example.com', password: 'abc456789' }
  ], null, 2);

  const textExamples = {
    tab: 'user1@example.com\tpassword123\nuser2@example.com\tabc456789',
    space: 'user1@example.com password123\nuser2@example.com abc456789',
    comma: 'user1@example.com,password123\nuser2@example.com,abc456789',
    pipe: 'user1@example.com|password123\nuser2@example.com|abc456789',
    dash: 'user1@example.com----password123\nuser2@example.com----abc456789',
    custom: 'user1@example.com::password123\nuser2@example.com::abc456789'
  };

  function showMessage(type, text) {
    messageBox.className = 'message show ' + type;
    messageBox.textContent = text;
  }

  function hideMessage() {
    messageBox.className = 'message';
  }

  function getCheckedValue(name) {
    const selected = query('input[name="' + name + '"]:checked');
    return selected ? selected.value : null;
  }

  function getDelimiterValue() {
    const delimiter = getCheckedValue('delimiter');
    const map = { tab: '\t', space: ' ', comma: ',', pipe: '|', dash: '----' };
    if (delimiter === 'custom') {
      return customDelimiterInput.value || null;
    }
    return map[delimiter] || '\t';
  }

  function setButtonsDisabled(disabled) {
    btnSingle.disabled = disabled;
    btnBatch.disabled = disabled;
  }

  function activatePanel(panelName) {
    tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.panel === panelName));
    panels.forEach((panel) => panel.classList.toggle('active', panel.id === 'panel-' + panelName));
    hideMessage();
  }

  function updateExample() {
    const format = getCheckedValue('batchFormat');
    if (format === 'json') {
      delimiterSection.style.display = 'none';
      batchInput.placeholder = '粘贴 JSON 数组，每项包含 email 和 password';
      batchExample.textContent = jsonExample;
      return;
    }

    delimiterSection.style.display = 'block';
    batchInput.placeholder = '每行一组账号，使用当前分隔符分隔 email 和 password';
    const delimiter = getCheckedValue('delimiter');
    batchExample.textContent = textExamples[delimiter] || textExamples.tab;
  }

  function updateCustomDelimiterVisibility() {
    customDelimiterRow.style.display = getCheckedValue('delimiter') === 'custom' ? 'flex' : 'none';
  }

  function parseJsonCredentials(input) {
    let parsed;
    try {
      parsed = JSON.parse(input);
    } catch (error) {
      throw new Error('JSON 格式无效：' + error.message);
    }

    if (!Array.isArray(parsed)) {
      throw new Error('JSON 顶层必须是数组');
    }

    return parsed.map((item, index) => {
      if (!item || !item.email || !item.password) {
        throw new Error('第 ' + (index + 1) + ' 项必须包含 email 和 password 字段');
      }
      return { email: item.email, password: item.password, sourceLine: index + 1 };
    });
  }

  function parseTextCredentials(input) {
    const delimiter = getDelimiterValue();
    if (delimiter === null) {
      throw new Error('请输入自定义分隔符');
    }

    const credentials = [];
    const lines = input.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) {
        continue;
      }
      const parts = delimiter === ' ' ? line.split(/\s+/) : line.split(delimiter);
      if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
        throw new Error('第 ' + (index + 1) + ' 行格式无效');
      }
      credentials.push({ email: parts[0].trim(), password: parts[1].trim(), sourceLine: index + 1 });
    }

    if (credentials.length === 0) {
      throw new Error('未解析到任何账号');
    }

    return credentials;
  }

  function handleSingleAdd() {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      showMessage('error', '请输入邮箱和密码');
      return;
    }
    setButtonsDisabled(true);
    showMessage('loading', '正在登录...');
    vscode.postMessage({ command: 'singleAdd', email, password });
  }

  function handleBatchAdd() {
    const format = getCheckedValue('batchFormat');
    const input = batchInput.value.trim();
    if (!input) {
      showMessage('error', '请先输入批量导入内容');
      return;
    }

    let credentials;
    try {
      credentials = format === 'json' ? parseJsonCredentials(input) : parseTextCredentials(input);
    } catch (error) {
      showMessage('error', error.message);
      return;
    }

    setButtonsDisabled(true);
    showMessage('loading', '正在导入 ' + credentials.length + ' 个账号...');
    vscode.postMessage({ command: 'batchAdd', credentials });
  }

  function bindEvents() {
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => activatePanel(tab.dataset.panel));
    });

    batchFormatRadios.forEach((radio) => {
      radio.addEventListener('change', updateExample);
    });

    delimiterRadios.forEach((radio) => {
      radio.addEventListener('change', () => {
        updateCustomDelimiterVisibility();
        updateExample();
      });
    });

    btnSingle.addEventListener('click', handleSingleAdd);
    btnBatch.addEventListener('click', handleBatchAdd);

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.command === 'result') {
        showMessage(message.status, message.message);
        setButtonsDisabled(false);
      }
    });
  }

  updateCustomDelimiterVisibility();
  updateExample();
  bindEvents();
})();
`;

type SingleAddMessage = {
	command: 'singleAdd';
	email: string;
	password: string;
};

type BatchAddMessage = {
	command: 'batchAdd';
	credentials: PasswordCredentialInput[];
};

type PanelMessage = SingleAddMessage | BatchAddMessage;

export class BatchAddPanel {
	private static currentPanel: BatchAddPanel | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly store: AccountStore,
		private readonly outputChannel: vscode.OutputChannel,
	) {
		this.panel.webview.html = this.getHtml();
		this.panel.webview.onDidReceiveMessage(
			async (message: PanelMessage) => this.handleMessage(message),
			null,
			this.disposables,
		);
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
	}

	static show(store: AccountStore, outputChannel: vscode.OutputChannel): void {
		if (BatchAddPanel.currentPanel) {
			BatchAddPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
			return;
		}

		const panel = vscode.window.createWebviewPanel('surfBatchAdd', 'Surf 批量添加账号', vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true,
		});
		BatchAddPanel.currentPanel = new BatchAddPanel(panel, store, outputChannel);
	}

	private async handleMessage(message: PanelMessage): Promise<void> {
		if (message.command === 'singleAdd') {
			await this.handleSingleAdd(message.email, message.password);
			return;
		}

		await this.handleBatchAdd(message.credentials);
	}

	private async handleSingleAdd(email: string, password: string): Promise<void> {
		const proxy = getProxyUrl();
		const proxyTag = proxy ? ` (代理: ${proxy})` : ' (直连)';
		this.outputChannel.appendLine(`[Login] 开始登录: ${email}${proxyTag}`);
		this.postResult('loading', `正在登录 ${email}...${proxyTag}`);

		try {
			const startedAt = Date.now();
			await this.store.addAccount(email, password);
			const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
			this.outputChannel.appendLine(`[Login] 登录成功: ${email} (${elapsed}s)`);
			this.postResult('success', `登录成功: ${email} (${elapsed}s)`);
		} catch (error) {
			const errorMessage = String(error).replace(/^Error:\s*/, '');
			this.outputChannel.appendLine(`[Login] 登录失败: ${email} - ${errorMessage}`);
			this.postResult('error', errorMessage);
		}
	}

	private async handleBatchAdd(credentials: PasswordCredentialInput[]): Promise<void> {
		try {
			this.postResult('loading', `正在导入 ${credentials.length} 个账号...`);
			const result = await this.store.batchAddAccounts(credentials);
			if (result.failedCount === 0) {
				this.postResult('success', `成功导入 ${result.successCount} 个账号`);
				return;
			}

			const failInfo = result.failures.slice(0, 3).map((failure) => `${failure.email}: ${failure.error}`).join('；');
			if (result.successCount > 0) {
				this.postResult('partial', `成功 ${result.successCount} 个，失败 ${result.failedCount} 个。${failInfo}`);
				return;
			}

			this.postResult('error', `全部失败 (${result.failedCount} 个)。${failInfo}`);
		} catch (error) {
			this.postResult('error', String(error).replace(/^Error:\s*/, ''));
		}
	}

	private postResult(status: 'loading' | 'success' | 'partial' | 'error', message: string): void {
		this.postMessage({ command: 'result', status, message });
	}

	private postMessage(message: unknown): void {
		void this.panel.webview.postMessage(message);
	}

	private dispose(): void {
		BatchAddPanel.currentPanel = undefined;
		this.panel.dispose();
		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
	}

	private getHtml(): string {
		return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Surf 批量添加账号</title>
  <style>${this.getStyles()}</style>
</head>
<body>
  ${this.getMarkup()}
  <script>${this.getScript()}</script>
</body>
</html>`;
	}

	private getStyles(): string {
		return PANEL_STYLES;
	}

	private getMarkup(): string {
		return PANEL_MARKUP;
	}

	private getScript(): string {
		return PANEL_SCRIPT;
	}
}
