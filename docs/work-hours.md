# 自动后台工作时间

这些设置只控制新的自动后台回合，不修改聊天、画图和手动请求；留空保留原行为。时间均按北京时间计算，多个时段用逗号分隔，例如 `18:00-09:00,12:00-14:00`。支持跨午夜，起点包含、终点不包含；相同起止为全天。填写非空无效格式时对应自动任务暂停，修正后恢复。窗口按每天重复，不自动判定周末或节假日；如果需要覆盖节假日全天，需要调整设置。

- 抖音和 B 站：各自的自动刷视频时间；留空沿用原有醒着时间。手动浏览、抖音私信与 B 站回复沿用原路径。
- QQ 空间：自动互动时间；留空沿用原有醒着时间。手动操作不受此项限制。
- 自驱引擎：自动工作时间；留空不限制。手动触发保留，正在执行的回合不强制中止。
- 鱼的世界：闲时生活与自动事件/计划分别设时段，默认留空。限制事件/计划可能耽误需要及时完成的工作或社交，外部机会可能过期；待办留存，主人安排和恢复仍即时处理。

贴吧、热榜、空间日记及 Thinkstar 夜间行动已提供各自时间配置，本次不重复增加；关闭的模块未添加设置。时间控制与价格服务商的实际账单是不同系统，设置本身不修改峰谷价格，也不能保证开始前提交的请求在窗口结束时立刻停止计费。

## 每日一次排期

自动 B 站和抖音的每日上限设为 1 时，每天首次自动尝试在启动前记账；失败或中断后当天不重复自动尝试。手动浏览仍可用。贴吧可通过一小时浏览窗口与至少一小时的间隔组合实现自然日最多一轮；热榜使用单一晚间时间避免错过早间时间后在峰时补跑。

空间日记新增 `onceDailyAttempt`，仅在每日次数为 1 时生效：自动任务开始前登记该时段，失败或中断当天不再重试，手动写日记不受影响；默认关闭以保持其他安装的旧行为。历史计划在当天已生成后仍按原机制保存，不因调整未来窗口而删除记录。

原生记忆的 `scheduledOncePerDay` 默认关闭；开启时，定时整理最多每天尝试一次，峰时不启动过期补跑。一次整理可以处理多个批次；失败或未处理完的剩余内容保留，等待后续整理或手动处理。此设置不关闭空闲提炼、即时记忆、检索及 Thinkstar 自己的夜间维护。旧记忆和聊天不因这一设置删除；每日尝试标记保存在原有 `runs` 元数据中，不改变 SQLite schema。

具体排程保存在本机配置，不纳入程序仓库。实际运行受服务在线、权限、平台状态和既有额度限制，失败不保证当天完成。

## 构建与部署

鱼世界版本通过 `node scripts/build-context-modules.js fish-world` 构建，采用 `node scripts/update-aurabot-module.js --extension fish-world --data-dir <绝对路径>` 预检，加 `--apply` 才应用。

本机 Aurabot 1.3.0-beta.1 的自驱、B 站、空间和抖音改动作为小型、基线哈希绑定的补丁维护在 `adapters/aurabot/native/work-hours-patches.json`。运行 `node scripts/update-work-hours.js --host-root <Aurabot程序根目录> --modules-root <Aurabot的modules目录>` 仅预检；加 `--apply` 后先备份旧程序到本仓库 GitHub Releases，匿名重新下载、解压到受管合成 scratch 并逐文件校验，再检查现场基线并应用。配置、聊天、数据库、凭据和模型不进入备份。现场程序有任何变化时拒绝覆盖，需要针对新基线重新生成和验证补丁。

每日一次增量保存在 `adapters/aurabot/native/daily-valley-patches.json`，通过 `scripts/update-daily-valley.js` 使用相同参数和恢复校验流程。原生记忆规则仍由 `patches.json` 管理：`scripts/update-native-group-adapters.js --data-dir <Aurabot目录> --builtin-src <Aurabot的src目录> --only memory` 仅预检该模块，加 `--apply` 才应用；`--only` 不会覆盖独立变化的 history-vault。原生旧代码校验使用受管 scratch 并保留回执。

更新后保留本机代码回退文件直至宿主验收；不在 `modules` 下创建额外副本。内置代码已经由运行中的 Node 加载时，需要受控重启宿主后才能确认生效。应先检查正在执行的工作、QQ 与世界操作，不强行中止未确认任务。保留用户数据和恢复回执。

## 验证

仓库测试使用 `node scripts/run-tests.js work-hours.test.js work-hours-patches.test.js work-hours-updater.test.js context-governance.test.js`。`DSH_ASAR` 和 `BILI_KERNEL_FILE` 指向本机对应组件时，还可运行真实版本的隔离兼容性验证；设置缺失时相关专项检查会明确跳过。所有模拟只在受管 scratch 使用合成数据；报告和清理回执保存在 `runtime-data/test-reports`。
