# Surf Account Manager

`Surf Account Manager` 是一个用于 VS Code 的账号管理插件，用来集中管理 Surf / Windsurf 账号，并在 IDE 内快速完成登录、切换和额度查看。

## Features

- 批量导入账号
- 单个账号登录与保存
- 一键切换当前账号
- 刷新单个或全部账号额度
- Tree View 分组展示当前账号、推荐账号、可用账号、异常账号
- Status Bar 显示当前账号摘要

## Usage

安装插件后，在侧边栏打开 `Surf 账号管理` 视图。

常见操作：

- 点击 `添加账号` 打开批量导入面板
- 点击账号项可直接切换当前账号
- 使用右键菜单刷新或删除账号
- 点击状态栏中的当前账号摘要可快速切换账号

## Commands

插件提供以下命令：

- `surf-account-manager.batchAdd`
- `surf-account-manager.switchAccount`
- `surf-account-manager.refreshAccount`
- `surf-account-manager.refreshAll`
- `surf-account-manager.deleteAccount`
- `surf-account-manager.deleteAll`

## Extension Settings

当前支持以下配置：

- `surfAccountManager.proxy`

示例：

```json
{
  "surfAccountManager.proxy": "http://127.0.0.1:7890"
}
```

当网络环境需要代理访问时，可以通过该配置或 `HTTPS_PROXY` 环境变量设置代理。

## Development

本地开发：

```bash
npm install
npm run compile
```

调试插件：

- 在 VS Code 中打开项目
- 按 `F5` 启动 `Extension Development Host`

打包为 `.vsix`：

```bash
npx @vscode/vsce package
```

## Known Limitations

- 账号展示目前默认使用邮箱作为主标识，后续可继续增加备注名/别名能力
- 部分额度数据依赖远端接口返回，若接口异常会显示为刷新失败或额度未知

## Release Notes

详见 `CHANGELOG.md`。
