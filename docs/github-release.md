# GitHub 与 Release 流程

独立源码仓库为 [rangesong/DSHaurabot-memory](https://github.com/rangesong/DSHaurabot-memory)，通过 [rangesong/DSH](https://github.com/rangesong/DSH) 的 `plugins/thinkstar-memory` 子模块引用。本机源码与Release工作区为 `D:\GitHub\DSHaurabot-memory`，从原 `thinkstarwork/github-repository` 整体迁移，保留 `.git`。旧thinkstarwork保留本机运行与私有验证材料。云端检查和发行状态以GitHub Actions与Releases实际记录为准，上传源码不等于已发布安装包。

## 独立仓库与DSH集合

Thinkstar的代码、文档、版本、CI与Release均在独立仓库维护。DSH只保存子模块地址和固定提交号，不复制完整插件代码，也不包含DSH或Aurabot本体。

获取集合及插件：

```sh
git clone --recurse-submodules https://github.com/rangesong/DSH.git
```

如果集合已克隆，在集合根目录执行：

```sh
git submodule update --init --recursive
```

维护者先在本插件仓库提交和推送。核对新版本后，在DSH集合根目录更新引用：

```sh
git submodule update --remote -- plugins/thinkstar-memory
git add plugins/thinkstar-memory
git commit -m "chore: update Thinkstar submodule"
git push
```

普通使用者执行 `git submodule update --init --recursive` 得到集合已经记录的版本，不会自动切换到插件的最新提交。集合的版本与Thinkstar的发行标签分别维护；Thinkstar的CI和Release工作流在独立仓库运行。

## 本机维护者更新

1. 在 `D:\GitHub\DSHaurabot-memory` 修改源码与 `docs/design/v5.md`、版本说明。
2. 使用 `node scripts/set-module-version.js <版本>` 同步项目及模块版本。
3. 执行下方检查与构建；更新 DSH 使用 `node scripts/update-aurabot-module.js --data-dir D:\DSH\plugins-data\aurabot --apply`。更新器先把旧代码上传到GitHub Releases，公开下载并恢复校验后才替换；成功后清理临时旧代码，保留云端回执，不交换模块数据与角色资源。详见[程序备份与恢复](code-backups.md)。
4. 查看 Git diff，核对后提交。第一次提交前按自己的身份配置 Git 作者。

迁移前的工作区同步器会读取本机迁移回执，并检查上次导出的文件哈希；新仓库出现独立修改后，它会停止并列出冲突，不覆盖改动。不要把旧目录继续当作主要开发源，不需要每次双向同步。同步清单不包含聊天、数据库、密钥、旧截图或模型二进制。

外部贡献者从 GitHub 克隆后，可直接在克隆目录中开发。

## 远程与公开范围

本次由维护者明确选择公开的 `rangesong/DSHaurabot-memory`，并以子模块方式加入公开DSH仓库。后续更换远程、权限或公开范围应单独核对。提交前执行仓库检查并查看待上传文件；聊天、数据库、密钥、运行日志及私人角色资源不得进入Git。Git作者身份与GitHub登录分别配置，凭据由Git标准凭据管理器处理，不写入源码。

## 检查与构建

`node scripts/check-repository.js` 只做语法、导入、版本、参数说明和已追踪文件边界检查，不启动记忆库。`node scripts/run-tests.js` 使用合成测试；私有角色未安装时，只跳过依赖该原始 GLB 的检查。安装了 npm 时也可使用对应的 package scripts；核心没有需要先安装的第三方依赖。

`npm run build:code` 仅生成代码包，适用于没有模型文件的 GitHub checkout。`npm run build:aurabot` 在本机同时生成代码包与角色资源包。`node scripts/check-release-artifacts.js` 解包验证 CRC、SHA-256、清单、导入及文件边界，不执行包里的模块。

## 创建版本

推送与模块版本完全一致的 `v<版本>` 标签后，Release 工作流调用 Windows/Linux 的检查与合成测试，再构建代码包，创建**未发布草稿**并上传 ZIP、`release.json` 和 `SHA256SUMS.txt`。失败时不进入草稿步骤，已发布版本的附件不会被覆盖。

工作流只使用仓库自带的 `GITHUB_TOKEN`，写权限限于草稿步骤。凭据不写入源码。资源包不由工作流自动上传；维护者可在核对资源与发布范围后单独维护它。

0.4.0 本机源码232项检查通过；不含私人 GLB 的导出仓库231项通过、1项资产检查按预期跳过。代码包与静态检查通过，并已在 DSH 核对栏目布局、参数与聚焦入口，执行20次隔离模型对比。完整范围和限制见 [0.4.0说明](../upgrade-0.4.0.md)。没有运行云端工作流；这些结果仍不代表真实宿主的所有长期边界都已验收。

接口依据：[官方 checkout](https://github.com/actions/checkout)、[setup-node](https://github.com/actions/setup-node)、[upload-artifact](https://github.com/actions/upload-artifact) 与 [Release API](https://docs.github.com/en/rest/releases/releases)。版本和管理方式按这些官方文档配置。

历史程序归档使用`code-backups-v<版本>`标签，与普通`v<版本>`Release草稿流程分开。历史备份不包含聊天、数据库、密钥和私人模型。每份快照的代码ZIP与恢复清单绑定内容hash，不覆盖已有不同附件。
