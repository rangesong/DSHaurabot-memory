# Thinkstar 文件组织与后续更新

2026-11-14。唯一业务设计基准仍为父目录 V5。源码只在 `thinkstarwork` 维护，生成包及安装副本都不是第二份开发源。下面的目录图描述本机维护目录；导出的 Git 仓库只包含受控源码和发布配置，其实际入口见仓库 README。

```text
thinkstarwork/
├─ core/                           记忆业务核心
│  ├─ v5-store.js                  SQLite、事务、来源、版本与任务
│  ├─ v5-runtime.js                接收、目录、检索、反馈与分层治理
│  ├─ v5-archive.js                L0原文/L1日摘要/L2月印象、分块复用与调用预算
│  ├─ v5-retrieval.js              纯本地BM25与派生分词
│  ├─ v5-facts.js                  主体/字段事实键、精确引用与版本撤回
│  ├─ v5-insights.js               上下文组成、遗漏和增减报告
│  ├─ v5-rules.js                  有来源且带条件的中枢准则
│  ├─ v5-config.js                 参数定义、默认值和硬约束
│  ├─ v5-param-help.js             参数含义及升降影响
│  └─ v5-model-service.js          语义协议；模型客户端显式注入
├─ shared/v5-memory-layout.js      跨核心与星图共享的七层布局、流向
├─ adapters/
│  ├─ deepseek-client.js           独立程序使用的 DeepSeek 客户端
│  └─ aurabot/
│     ├─ reader.js / mapper.js     旧来源只读采集与转换
│     ├─ live-reader.js            独立程序的只读文件轮询
│     └─ module/                  Aurabot 原生模块源
│        ├─ module.json           模块 ID、版本、能力及最低宿主版本
│        ├─ index.mjs             模块设置与 setup
│        ├─ panel.js              Aurabot 自定义管理面板
│        └─ lib/
│           ├─ host-bridge.js     生命周期、事件、范围、工具、管理路由
│           ├─ memory-compat.js    内置公开接口成功写入同步及动态委托
│           └─ host-model-client.js  复用 api.ask 的模型边界
├─ server/memory-sea-handler.js    两种运行方式共用的 HTTP/静态资源白名单
├─ apps/memory-sea/               唯一星图界面、角色、相机和参数面板
├─ scripts/
│  ├─ serve-memory-sea.js         独立启动装配，不承载业务实现
│  ├─ build-aurabot-module.js     白名单打包、哈希、代码包与资源包
│  ├─ lib/zip.js                 本地确定性 ZIP 编码
│  └─ run-node-task.cmd          两个桌面入口共用的 Node 定位
├─ test/                         现有核心及适配契约的验证代码
├─ docs/                         设计、操作、接入、验收与已知边界
├─ runtime-data/                 私人运行数据，不打包
├─ release/                      资源版本与 GitHub 仓库模板
├─ github-repository/            专用本地 Git 工作区及 Release 工作流
└─ dist/aurabot/                 自动生成的安装目录、ZIP、release.json
```

## 依赖方向

核心不导入 Aurabot、DSH、DOM、HTTP 服务或密钥读取代码。模型服务只接受客户端接口，独立启动器注入 DeepSeek 客户端，宿主适配层注入 DSH 客户端。界面通过相同的 HTTP 契约访问核心。

原生模块和只读文件导入是两种入口，不在模块中启动旧文件轮询，不自动把上游数据库作为本模块的可写底座。未来其它宿主在 `adapters/<host>/` 实现同样的边界，不往核心散布宿主判断。

## 更新顺序

1. 按职责修改这一份源码：记忆行为改 `core`，Aurabot 生命周期与消息形状改适配层，图面改 `apps`，跨端布局改 `shared`。
2. 参数有新增或语义变化时，同步更新 `v5-param-help.js`。配置响应中的帮助字段是新增字段，原参数元组格式保持兼容。
3. 升级 `module.json` 与模块入口版本，补接入说明和实际验证记录。业务核心与宿主适配版本分开记录。
4. 双击 `打包Aurabot模块.cmd` 或执行 `npm run build:aurabot`。构建包只含源码白名单、许可证和公开背景；模型单独打包。禁止手改 `dist`。
5. 先在隔离环境验收，再更新实际安装目录。停模块、备份、替换代码、重启，保留模块数据与资源目录。不同版本不得同时写同一底座。

## 数据库演进

0.3.11 使用 `thinkstar_storage_schema=2`：共享引用无损解码，当前版本以标记去重，修改前在事务中保全旧快照；结构1先建立一致性备份再升级。垃圾桶采用 `rubbishmemory/年份/年份-月份.sqlite`，完整材料按实际遗忘月份独立保存，不参与正常检索。每日夜间维护清理无主引用并按阈值回收空页。以下为此前阶段的兼容历史：0.3.0 使用既有 JSON/meta 存储归档与事实版本，并对可重建的检索文本做一次 NFKC 归一；不改规范原话。启动时遇到不兼容版本会拒绝打开业务流程，避免旧代码回退后误改新库。未来结构变化应增加明确的 schema 版本和单向迁移文件，迁移前生成一致性备份，事务内升级，失败保持旧库可恢复。不能把构造函数中的随意补字段当作破坏性迁移方案。

回退能力须按版本声明：仅代码兼容时可直接回退代码；不兼容的表结构必须恢复配套备份。不得通过重新导入原聊天来伪造旧状态、人格或对象版本。

## 发布产物

`thinkstar-memory-<版本>.zip` 根目录是 Aurabot 要求的 `module.json`、`index.mjs`、`panel.js`。`engine/` 保留源码的相对路径关系，由唯一源码自动复制，不手工维护。

模型放在独立资源包并安装到 `modules-data/thinkstar-memory/assets`，避免 Aurabot 的代码热加载反复快照约 39 MB 的 GLB。本机市场代码包压缩上限 25 MB、解压总量上限 64 MB；构建器显式检查代码包大小。

`release.json` 记录文件清单、SHA-256、代码版本、资源包版本和结构版本。聊天、SQLite、配置、密钥、旧导入快照和运行日志均不属于发布产物。

## 专用 Git 与发布工作区

按用户指定，仓库位于 thinkstarwork 内的 `github-repository`，没有在 thinkstarwork 根目录初始化 Git。开发源码仍维护在原目录；`同步GitHub仓库.cmd` 按白名单同步到专用工作区，并保留 `.git`。导出器在写入前比较上次快照哈希，仓库的独立修改会被明确拦住。

仓库使用单独的 README、贡献说明和 `.github` 工作流模板，维护源位于 `release/github`；业务代码仍来自同一份 core、adapters、server 和 apps。外部 GitHub 修改需要先带回这些开发源或模板，不能长期各改一份。

同步与模块构建归一化文本行尾，代码在不同平台 checkout 时保持稳定；角色二进制、运行库、密钥、历史截图、生成包及嵌套工作区不会被导出。`release/resources.json` 单独记录角色资源版本和哈希。

## 0.3.0 业务绑定

三层归档、默认原文保留、事实键、BM25和上下文洞察见 [本轮设计与取舍](memory-reference-upgrade.md)。前额皮层增加两个BM25参数，海马体增加原文保留和每日归档调用数，全部71项有面板说明。

0.2不了解归档内部缓存和新的保留政策；即便SQL表结构相同，降级也应恢复升级前的配套备份，不能直接用旧版继续治理升级后的库。模型请求未知时不自动重试，热重载先停止旧请求提交，避免旧结果写回新状态。
