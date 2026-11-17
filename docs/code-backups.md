# 程序备份与恢复

旧版Thinkstar程序现在保存在 [GitHub Releases](https://github.com/rangesong/DSHaurabot-memory/releases)，标签为 `code-backups-v<版本>`。本地不再长期堆积完整的旧安装目录。

## 已完成的归档

2026-11-17归档并清理29个旧程序目录（包含全部12个`_thinkstar-before`目录）和27个旧安装包，覆盖22个版本、33份不同代码快照，释放268,523,302字节，约269MB。每份不同快照均附程序ZIP和`.restore.json`恢复清单。相同快照的重复本地副本共用云端对象。

每项在本地删除前，均已上传、从发布后的公开地址重新下载、核对ZIP的SHA-256、解压到临时目录，再逐个核对程序文件。另用独立恢复命令下载0.5.1，成功加载入口并在合成空数据环境初始化了模块，没有读取正式记忆或发消息。

本批次公开索引见 [code-backup-index.json](../release/code-backup-index.json)。索引只含版本、文件名、校验值和公开地址，不含本地路径、聊天或密钥。之后新增版本以Releases中的实时附件为准。

## 上传范围

- 仅接受有有效`thinkstar-build.json`清单、版本一致且文件逐个匹配的程序目录或代码安装包。
- 上传前检查路径、清单、程序语法、相对导入、JSON与疑似凭据。未知文件或私人内容使归档停止。
- 数据库、聊天、记忆垃圾桶、备份数据库、日志、密钥、私人GLB/模型资源包不上传。
- 宿主生成的`.aurabot-cache`不上传。只有其内容也被确认为可重建代码，才随对应的旧程序目录清理。
- 当前运行的插件、当前0.5.2安装包及私人资源包保留。本次归档不是记忆云备份。

## 以后怎样更新

在维护仓库执行：

```powershell
node scripts/build-aurabot-module.js --code-only
node scripts/update-aurabot-module.js --data-dir D:\DSH\plugins-data\aurabot
node scripts/update-aurabot-module.js --data-dir D:\DSH\plugins-data\aurabot --apply
```

第二条只核验；第三条实际更新。更新器先把现用旧代码归档到GitHub，公开下载并恢复校验成功后，才在同一磁盘暂存新代码和进行替换。新代码再次核验成功后，移除临时旧代码目录，留下小型回执，不保留完整旧程序副本。

需要联网及该仓库的Release写权限。默认复用本机Git凭据管理器；CI可使用`GITHUB_TOKEN`。凭据只在内存中使用，不写入源码、日志或归档。其他维护者需将`release/backup-policy.json`的仓库改为自己有写权限的位置。

上传、公开下载或恢复校验失败时，在替换前中止；本机旧程序仍在。替换失败时恢复暂存旧代码。若清理时发现额外文件或代码变化，则保留该目录并记录待检查，不强行删除。临时目录位于Thinkstar自己的`modules-data/thinkstar-memory/update-staging`，正常完成后清空，不放进`modules`扫描目录。

## 怎样恢复旧代码

例如把0.5.1的指定快照恢复到一个不存在的新目录：

```powershell
node scripts/restore-code-backup.js --version 0.5.1 --snapshot 8cb9b2797c5b1d4d --output D:\ThinkstarRestore\0.5.1
```

公开下载不需要登录。同一版本存在多个快照时，用公开索引或命令列出的文件名选择对应hash前缀。恢复命令会核对清单并导出完整程序，不覆盖正在使用的插件或数据库。

备份标签用于组织附件，标签处自动生成的GitHub源码压缩包不一定对应那个历史安装快照；恢复历史程序请使用带hash的程序ZIP和恢复清单。

**代码恢复成功不等于所有旧版本都兼容现在的记忆库。** 尤其是旧数据库结构版本，需要另外核对配套版本和私人数据库备份；不能把旧程序直接连到正式记忆库试运行。私人数据备份继续留在原位置，未上传或清理。

## 验证

新增12项定向回归覆盖：排除私人数据、完整恢复、发布后附件地址变化、失败保留、哈希变化、当前安装包保留、草稿重试、更新失败保护、私人文件出现时停止清理、Windows目录重定向保护。归档过程的本地记录位于`runtime-data/installations/cloud-archive-receipts.json`及`cloud-package-receipts.json`，不提交Git。
