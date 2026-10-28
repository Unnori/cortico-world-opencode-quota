OpenCode 额度 World 定时读你正在用的 OpenCode 端点的订阅额度。此刻监控的端点:{{opencode-quota.endpoints}};最紧的一个窗口是 {{opencode-quota.worst}};上次读到的时刻是 {{opencode-quota.lastRead}}。

用户问到额度、还剩多少、还能用多久时,先调用 ocq_read 取此刻的数字再回答;要看趋势就调 ocq_history。这两个工具只读,不消耗额度。

不要主动报额度数字。只有收到额度相关的事件(越过告警线、窗口重置)时,才按事件正文说一句;没收到就别提,也不要定期汇报。
