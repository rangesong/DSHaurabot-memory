# 原生人物画像持续更新补丁

适用 Aurabot `1.3.0-beta.1` 的已审核安装代码。源码与面板均用完整 SHA256 锁定，未知版本拒绝替换；已安装相同补丁时不重复修改。

原生每日整理先刷新人物画像、后压缩事实，压缩又会删除画像。补丁改为合并及压缩完成后统一刷新一次。压缩保持事实原意时，保留原画像并标记待更新，新画像生成成功后才替换。明确纠正、撤回、忘记及未知原因导致的失效继续立即停用旧画像，不能被后续压缩降级为可用。

待更新或只有结构字段而缺少整体文本的画像可在后台补写，不再依赖新聊天达到提炼行数。沿用每日整理开关和峰谷策略；不增加正常私聊的同步等待。更新生成期间，事实、人物画像、人格或忘记请求发生变化时拒绝覆盖，防止旧结果写回。每个人同一时刻最多一项生成。

自动画像调用独立记账：每人每天最多 3 次，全部人物每天最多 24 次；开始调用前持久记录，失败也计入。成功后最少间隔 30 分钟，失败按 30、60、120 分钟退避，上限 120 分钟。日期按宿主本地日期计算。手动“重写”保留原有立即调用方式，不消耗自动额度；同人并发生成仍被阻止。未增加配置项，也未改回忆预算、QQ 分享或会话创建逻辑。

面板有旧画像时继续展示；没有画像但已排入更新时显示“整体印象待更新，已有记忆仍保留”，与从未生成作区分。

## 安装与验证

```powershell
node scripts/update-aurabot-module.js --data-dir D:\DSH\plugins-data\aurabot --native-host D:\DSH\profiles\desktop\node_modules\dsh-aurabot-qq --repair-profiles
node scripts/update-aurabot-module.js --data-dir D:\DSH\plugins-data\aurabot --native-host D:\DSH\profiles\desktop\node_modules\dsh-aurabot-qq --repair-profiles --host-origin http://127.0.0.1:60645 --apply
```

第二条先核对宿主空闲，上传完整允许公开的旧程序代码到配置的 GitHub Release，并公开下载、解压及落盘恢复校验，通过后才替换。私有数据库、聊天、凭据及模型不进入归档。安装后使用宿主原生 memory 模块重载接口；面板刷新后使用新显示文本。更新器不自动发送消息、调用模型或重新启动整个程序。

标准验证使用 `node scripts/run-tests.js native-profile-lifecycle.test.js native-chat-updater.test.js native-group-policy.test.js`。合成数据仅进入受管 scratch，完成后自动清理，报告与回执保留。

## 数据与回退

SQLite schema 保持 1，无表迁移。现有 `dirtyProfiles` 新增兼容值 `compression`；旧版本会把它按真值视为待重建，可能暂时不注入旧画像。新增顶层 `profileRefreshAttempts` 只是自动调用计数与退避时间，由现有通用 KV 存储保存，旧版本会保留但忽略。人物事实及其历史、相处经验、关系、手动标签和聊天不迁移或删除。

回退时使用本次代码回执指定的 Release 附件，在新目录验证完整代码后替换相应程序；不把旧备份数据库覆盖到当前库。旧程序不会得到本补丁的压缩保留行为，需要按当时有效事实重建画像。只有公开恢复验证与宿主验收均通过后，才允许清理本次受管本地代码备份；私人数据库备份保留。
