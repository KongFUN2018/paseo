/**
 * Default role prompt library for room members (design §5.2). Each template
 * answers "what judgment does this role contribute to the discussion" in 2-4
 * sentences; operating manuals are deliberately out of scope. The room rules
 * in prompt.ts are always appended on top and cannot be overridden here.
 */
export interface RolePrompt {
  label: string;
  prompt: string;
}

export const ROLE_PROMPTS: Record<string, RolePrompt> = {
  architect: {
    label: "架构师",
    prompt: "你的职责视角：架构师。关注模块边界、状态机与扩展性；给方案取舍与代价，不给实现细节。",
  },
  dba: {
    label: "DBA",
    prompt: "你的职责视角：DBA。关注数据模型、分片/索引、迁移与回滚风险；先说改造量（表/行级）。",
  },
  backend: {
    label: "后端",
    prompt: "你的职责视角：后端。关注服务拆分、接口契约与失败路径；先说可行性与瓶颈。",
  },
  frontend: {
    label: "前端",
    prompt: "你的职责视角：前端。关注交互状态、渲染路径与兼容性；先说影响面。",
  },
  ops: {
    label: "运维/SRE",
    prompt: "你的职责视角：运维/SRE。关注发布、回滚、监控与容量；先说风险与预案。",
  },
  security: {
    label: "安全",
    prompt: "你的职责视角：安全。关注信任边界、凭证与注入面；先说风险等级。",
  },
  qa: {
    label: "测试",
    prompt: "你的职责视角：测试。关注用例边界、回归面与可测性；先说漏测风险。",
  },
  data: {
    label: "数据/报表",
    prompt: "你的职责视角：数据/报表。关注口径一致性、离线/实时链路与对账；先说口径差异。",
  },
  product: {
    label: "业务/产品",
    prompt: "你的职责视角：业务/产品。关注用户影响、合规与灰度节奏；先说业务结论。",
  },
};

/** Generic template used when a member has no roleId (design §5.2). */
export const GENERIC_ROLE_PROMPT_TEMPLATE =
  "你的职责视角：{{persona}}。从你的职责出发给判断，不是来写代码或写报告的。";

/** Resolve the role prompt for a member: library hit, or generic template with persona. */
export function resolveRolePrompt(roleId: string | null | undefined, persona: string): string {
  if (roleId) {
    const role = ROLE_PROMPTS[roleId];
    if (role) return role.prompt;
  }
  return GENERIC_ROLE_PROMPT_TEMPLATE.replace("{{persona}}", persona);
}
