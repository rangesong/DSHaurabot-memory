# 项目协作约定

- V5 基准在 docs/design/v5.md；核心、宿主适配和星图按目录分工，业务实现只保留一份。
- 不修改外部 Aurabot 源码、配置、业务库或发送消息，除非当前用户明确授权相关动作。模块实际运行时只拥有自己的模块数据目录。
- 使用用户当前允许的验证方式。需要测试时使用合成数据和独立临时库，不把旧测试或静态检查描述为真实宿主验收。
- 不提交 runtime-data、SQLite、凭据、聊天、私有截图或大模型资源。
- 不直接编辑 dist；版本由 scripts/set-module-version.js 同步，再由构建器生成。
- 程序更新统一用 scripts/update-aurabot-module.js：旧代码先上传指定 GitHub Releases，公开下载、解压和文件校验成功后再替换并清理本地旧副本；失败保留。禁止再向 modules 创建 _thinkstar-before 备份。数据库、聊天、密钥、私人模型不上传；恢复旧代码只导出到新目录，数据库兼容性另核对。
- 有参数变化时同步帮助说明；有数据库变化时明确 schema、迁移及回退。
- Windows 目录删除或移动前确认绝对目标在当前工作区内，保持文件操作在同一工具/运行时中完成。
- 测试统一使用 `node scripts/run-tests.js`（可追加测试文件名）；容量/性能测试使用 `test:years`、`test:scale`、`test:bench`。新测试的数据库、缓存和临时复制件只放带归属标记的测试scratch；报告放 `runtime-data/test-reports`。完成或失败均清理临时数据，报告保留。自定义验证也应复用 `scripts/lib/test-workspace.js`。
- 自动清理只允许删除本次明确创建、仅含合成数据的受管测试目录。不得按SQLite扩展名、目录年龄或整个runtime-data批量清理；不得触碰真实记忆、遗忘垃圾桶、私人模型、必要迁移备份。真实历史验证材料不纳入自动清理；如需回收单独核对。GitHub只保存代码及允许公开的资源。
