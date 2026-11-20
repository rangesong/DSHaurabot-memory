# 测试临时数据与报告

标准入口：

```sh
npm test
node scripts/run-tests.js test-workspace.test.js
npm run test:years
npm run test:scale
npm run test:bench
npm run test:cleanup
```

无需安装额外依赖。使用标准入口才能得到统一报告与整轮清理；直接执行`node --test`只保留各测试原有的局部清理。

每次运行创建独立的`runtime-data/test-tmp/run-<随机编号>/scratch`，归属标记记录项目根目录、主子进程、机器、时间和合成数据用途。数据库、WAL/SHM、缓存、合成迁移副本及测试启动器副本均放在scratch内。TEMP、TMP、TMPDIR和测试专用路径共同指向这里，不改生产库配置。

`runtime-data/test-reports/<编号>/`永久保留本地测试报告：`test.log`是输出，`summary.json`包含状态、退出码、时间和清理结果；容量/性能脚本另存`result.json`。报告不随临时库删除，不被Git跟踪。CI使用合成数据，报告上传Actions Artifact保留30天；代码与公开资源才进入源码和Release。

测试成功、断言失败或子进程异常退出后，都先落盘报告，再清理本次受管目录。清理失败返回非零状态并保留待核对目录。正常中断会终止测试进程树再保存报告；强制结束、断电等情况可能留下临时目录，下次测试或`npm run test:cleanup`会核对：同一机器、同一项目、明确归属标记、主子进程已结束、创建至少一小时。仍活动、时间不明、无标记、含目录链接或未知同级文件的目录不删除。已有报告保留，并补充中断恢复记录。

自动清理不扫描全盘或整个runtime-data，不按`.sqlite`后缀或“文件旧”判断。真实记忆、导入聊天、遗忘垃圾桶、任何真实模型文件（包括私人及可公开模型）、原始素材、必要数据库备份和真实历史对比材料均不在清理范围。旧程序代码备份继续走[GitHub Releases恢复校验流程](code-backups.md)，不是测试垃圾清理。

三年容量检查默认1095天、每天405条合成输入；小规模流程验证可设置`THINKSTAR_SCALE_DAYS`和`THINKSTAR_DAILY_RECORDS`。要比较旧版，显式设置`THINKSTAR_BASELINE_ROOT`为已恢复的参考源码根目录；默认只检查当前版本，并在报告标记未比较旧版。旧版只打开scratch里的合成数据库副本，不使用正式记忆库。小规模运行不能当作完整三年容量证据。

新增测试通过`testRuntimeRoot(fallback)`取得受管临时根目录；独立合成检查通过`managedScript`执行、`writeTestResult`保存结果。自定义验证复用`runManagedTest`，不得把真实数据放进声明为合成且可丢弃的目录。真实历史验证必须单独明确资料与备份边界。

验证：新增8项定向清理回归通过；最终完整隔离回归293项，292通过、1项私人GLB检查按预期跳过、0失败。旧thinkstarwork入口98项相关回归通过。三年脚本以3天、每天5条验证报告、重启回查和临时双库清理流程，不把本次小规模验证当作完整三年容量证明。最终受管临时目录为空。
