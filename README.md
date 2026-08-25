# Skill 拆解器

一个本地优先的 macOS 桌面应用，用于导入、浏览、拆解和整理 Agent Skill。

## 运行

需要 Node.js 22 或更高版本。

```bash
npm ci
npm run dev
```

使用 `npm ci` 可以严格按仓库中的 `package-lock.json` 还原开发依赖；需要更新依赖时再使用 `npm install`。

## macOS 打包

在 Apple 芯片（arm64）Mac 上生成“手动放行内测版”应用和 ZIP：

```bash
npm run dist:mac
```

生成的文件位于 `release/`：

- `mac-arm64/Skill 拆解器.app`：可直接双击运行的应用；
- `Skill 拆解器-<版本>-arm64-testing.zip`：可分发的内测安装包。

内测版会对整个应用包做 ad-hoc 完整性签名，避免把未封签的包误报为“已损坏”。它没有 Apple Developer ID，也未公证：首次打开仍可能被 Gatekeeper 拦截。请解压 ZIP、将应用拖进“应用程序”后，在 Finder 中按住 Control 点按应用并选择“打开”，再在确认框选择“打开”；不要通过终端关闭系统安全检查。`release/` 会同时生成校验值和 `内测安装说明.txt`，分享时请一并发送。

面向其他用户正式分发前，仍需使用 Apple Developer 证书完成 Developer ID 签名与公证。

## GitHub 仓库约定

建议先将仓库设为私有。仓库只保存可复现构建所需的源码、测试、构建脚本和文档；以下内容被 `.gitignore` 排除，不能上传：

- API Key、`.env` 文件、证书请求、签名证书与私钥；
- 本地数据库、日志、Electron/Vite 缓存与依赖目录；
- `release/` 下的应用、ZIP、DMG 和校验文件。

AI Key 不会写入项目源码或 Git 仓库。应用在 macOS 上使用 Electron `safeStorage` 和系统 Keychain 保存该密钥。

如需向测试者分发版本，请在 GitHub Releases 中单独上传 `release/` 生成的 ZIP、对应 `.sha256` 校验文件和 `内测安装说明.txt`；不要把安装包提交进 Git。

## 校验

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

## 数据与隐私

- 本机 Skill 会先复制到应用资料库，原目录不被修改。
- GitHub 导入只克隆和读取，不执行仓库脚本、Hook、子模块或安装命令。
- 规则拆解完全在本地运行。
- AI 仅在用户选择文件并二次确认后调用。
- API Key 使用 Electron `safeStorage` 保存；在 macOS 上由 Keychain 保护。

详细需求见 `PRD-Skill-拆解器-MVP.md`，系统与交互设计见 `design-document.md`。
