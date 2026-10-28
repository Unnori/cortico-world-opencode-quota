/** 包入口:默认导出 `WorldDefinition`,加载器按 `cortico.kind === 'world'` 认它。 */
import { OPENCODE_QUOTA } from './definition.ts';

export default OPENCODE_QUOTA;
export { OPENCODE_QUOTA };
export type { OpenCodeQuotaConfigSection } from './config.ts';
export { OPENCODE_QUOTA_TOOL_DECLS, OpenCodeQuotaWorld } from './world.ts';
