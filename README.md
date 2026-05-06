# Surf Account Manager

`Surf Account Manager` 是一个用于 VS Code 的账号管理插件，用来集中管理 Surf / Windsurf 账号，并在 IDE 内完成账号添加、登录、切换、额度查看和导出。

## Features

- 批量导入账号
- 单个账号登录与本地激活
- 刷新单个或全部账号额度
- 在账号 tab 中查看今日额度、本周额度、套餐到期时间和异常状态
- 按今日是否有额度分组排序，并在组内按套餐到期时间从近到远排序
- 支持导出单个账号或全部账号的邮箱/密码 JSON
- 支持删除单个账号或删除全部账号

## Usage

安装插件后，在侧边栏打开 `Surf 账号管理` 视图。所有账号操作都在 `账号列表` tab 中完成，不再通过命令面板、视图标题快捷按钮、右键菜单或状态栏入口操作。

顶部工具栏：

- `刷新全部`：刷新所有账号额度
- `添加帐号`：打开批量导入面板
- `导出全部`：复制全部账号邮箱和密码 JSON 到剪贴板
- `删除全部`：确认后删除全部账号

账号卡片操作：

- `刷新`：刷新当前账号额度
- `登录`：登录并激活该账号
- `删除`：确认后删除该账号
- `导出`：复制该账号邮箱和密码 JSON 到剪贴板

账号卡片会展示：

- 邮箱
- 当前/可用/低额度/异常状态
- 今日剩余额度
- 本周剩余额度
- 套餐到期时间
- 若套餐在本周额度重置前到期，会显示红色提示

## Extension Settings

当前支持以下配置：

- `surfAccountManager.proxy`：HTTP/HTTPS 代理地址，留空则不使用显式代理
- `surfAccountManager.autoRefreshIntervalMinutes`：账号额度自动刷新间隔，设为 `0` 可关闭定时更新

示例：

```json
{
  "surfAccountManager.proxy": "http://127.0.0.1:7890",
  "surfAccountManager.autoRefreshIntervalMinutes": 30
}
```

当网络环境需要代理访问时，可以通过 `surfAccountManager.proxy` 或 `HTTPS_PROXY` 环境变量设置代理。

## Development

安装依赖：

```bash
npm install
```

编译：

```bash
npm run compile
```

Lint：

```bash
npm run lint
```

调试插件：

- 在 VS Code 中打开项目
- 按 `F5` 启动 `Extension Development Host`

打包为 `.vsix`：

```bash
npm run package
```

## Known Limitations

- 账号展示目前默认使用邮箱作为主标识，后续可继续增加备注名/别名能力
- 部分额度数据依赖远端接口返回，若接口异常会显示为刷新失败或额度未知

## Release Notes

详见 `CHANGELOG.md`。
