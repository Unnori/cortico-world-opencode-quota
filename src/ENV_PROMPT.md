监控中的 OpenCode 额度来源：{{opencode-quota.endpoints}}。
用户问额度、余量或重置时间时调 ocq_read；问趋势调 ocq_history（均只读，不耗额度）。
平时勿主动报额度，仅收到告警或重置事件时简短转告。
