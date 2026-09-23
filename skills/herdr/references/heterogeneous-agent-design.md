# 异构 Agent 配置、执行契约与 Jev 问题模型

状态：2026-09-23 经 GPT-6 Pro 审查后修订的设计基线；用户随后授权实现。当前入口、实际能力和保守限制见 [Jev 调度使用说明](jev-scheduling.md)。下文保留设计时的论证。

## 目标与边界

用户已确认：使用一个配置文件声明执行组合，通过异构 engine 兼容层按任务复杂度自动选择 engine、模型和思考力度；整体数据结构与 Jev 问题模型需要共同设计。

本稿建议：配置定义执行策略，主 Agent 定义任务与验收，Jev 判断有限的语义问题，程序执行确定性约束检查，Herdr 管理运行资源。首版保持单主 Agent 调度，不构建分布式队列、全局注册中心或通用工作流平台。

设计前的 `jev-decision.ts` 将一个固定 executor 放在 batch 中，每个候选 wave 同时绑定任务和 low/medium/high effort。异构路由会改变这个输入契约；属于非数据库变更，不保留旧 batch 的兼容分支。现有依赖、资源冲突、容量、上下文预算、显式退出和响应校验逻辑继续复用。

## 数据对象及其权威来源

| 对象 | 责任与权威来源 | 不应包含 |
| --- | --- | --- |
| RoutingConfig | 用户维护 engine 实例与三档路由中的执行组合 | 任务状态、凭据值、CLI 命令模板 |
| TaskSpec | 主 Agent 定义目标、证据、依赖、写入所有权、验收与能力需求 | Jev 猜测的实际运行状态 |
| TaskAssessment | 对指定任务 revision 的复杂度判定和来源 | 执行授权、验收结论 |
| RuntimeSnapshot | 调度器采集实际容量、占用、engine 能力与任务状态 | 对未知状态的成功推断 |
| WaveProposal | 程序构造、已通过机械约束的有限执行候选 | 尚未解析的模型别名、任意 shell 字符串 |
| DecisionRecord | 记录问题、候选、回答、策略版本、输入摘要及采纳结果 | 后续可变配置的引用替代品 |
| ExecutionAttempt | 一次执行的完整绑定、提交状态、运行句柄与产物 | 把进程结束当作任务已验收 |

这些是逻辑对象，实际只需四类持久内容：配置、任务记录（含 assessment/验收）、决策记录（含 snapshot/wave）、attempt 记录。复用现有私有任务记录，不意味着七张数据库表。配置与私有运行记录分开，运行记录不进入技能源码或 Git。

## 一个配置文件

默认建议 `~/.config/herdr/agents.json`，`--config` 可选择另一份完整文件；首版不做多层合并。该文件由技能调度脚本读取，不宣称 Herdr 原生 config.toml 已支持这些字段。

```ts
type Complexity = "ordinary" | "moderate" | "complex";
type Reasoning =
  | { mode: "effort"; value: string }
  | { mode: "engine_default" };

type ExecutionProfile = {
  engine_id: string;
  model: string;
  reasoning: Reasoning;
};

type RoutingConfig = {
  version: 1;
  engines: Record<string, {
    adapter: "codex" | "qodercli";
    max_parallel: number;
  }>;
  routes: Record<Complexity, ExecutionProfile>;
  limits: { max_parallel: number };
};
```

engine ID 是配置中的执行实例，adapter ID 是代码中已注册的兼容实现。ExecutionProfile 是不可拆开的 engine/model/reasoning 组合，直接内嵌 routes，不增加独立的具名 profiles 注册表。同一个 engine 可以被多个档位引用，共享同一并发额度。首版每个 adapter 只配置一个 engine 实例，避免没有隔离机制的重复实例被误当成独立容量。

`max_parallel` 计数活动执行单元，包括本地预留、启动中、提交中/未知和执行中；不是进程上限或供应商账户限流。主 Agent 和已知批次外活动计入实际可用额度，闲置会话不按活动任务计数。Jev 模型和超时/门槛沿用现有脚本设置，不要求在用户配置里再维护一套决策器参数。

当前 Herdr `agent start --kind` 使用对应的规范可执行程序，只接受附加 Agent 参数。因此不开放任意 executable 配置；adapter 输出 `kind + argv`。实际解析到的可执行路径和 CLI 版本可以作为探测证据记录，不宣称能通过该入口选择任意二进制。

例如普通任务可映射 Qoder + Qwen3.8-Flash + 原生 Extra High，中等和复杂任务映射不同 Codex 组合。具体模型与 effort 值由 adapter 核实，设计示例不冒充已验收的启动配置。

`reasoning.value` 属于 engine/model 的原生命名空间，不能跨引擎比较或按字符串排序。上一版口头方案中的统一 xhigh 枚举撤回。adapter 校验具体值并转换启动参数；未来确需 token budget/adaptive 时扩展带 tag 的 union，不提前制造通用参数字典。`engine_default` 必须显式声明；自动力度策略的默认配置使用明确 effort，禁止参数缺失悄悄继承 CLI 默认值。

路由首版每档只指定一个执行组合。用户显式指定执行组合时由主 Agent 记录为该次冻结绑定的来源，仍须满足能力、容量和授权约束；首版不再增加具名 profile override 语法。路由不可用时返回明确原因，不把复杂任务降档，也不为了找到可用 engine 把普通任务改判为复杂任务。备用列表、动态成本优化和自动升级暂不加入。

静态加载校验：严格拒绝未知键、缺失路由、悬空 engine 引用、非法正整数、未知 adapter；根据 adapter schema 校验原生参数。模型名是原生字符串，不套用内部 ID 的命名正则。凭据继续沿用各 CLI 和现有环境机制，不进入该文件。权限模式不由 Jev 或路由自动扩大。

每次派发固定解析后的配置快照与内容 hash。以本地锁内原子持久保存 wave 的 attempts 和预留作为派发提交点：提交前配置变化，决策失效；提交后 attempts 使用已冻结组合，普通配置修改只影响新提交。任务取消、权限撤销和执行边界失效仍须阻止后续副作用，不能被冻结语义覆盖。

## 任务与运行状态分开

```ts
type ResourceDeclaration =
  | { status: "known"; reads: string[]; writes: string[] }
  | { status: "unknown"; reason: string };

type TaskSpec = {
  id: string;
  revision: number;
  summary: string;
  inputs: { summary: string; evidence_refs: string[] }[];
  deliverable: string;
  acceptance: string[];
  depends_on: string[];
  resources: ResourceDeclaration;
  uncertainties: { description: string; blocking: boolean }[];
  requirements: {
    capabilities: string[];
    owner_only: boolean;
  };
  decision_boundary: {
    delegated: string[];
    reserved_for_owner: string[];
    authorization_refs: string[];
  };
  execution: { cwd: string; workspace_ref: string };
};

type TaskState =
  | "pending" | "blocked" | "running" | "awaiting_acceptance"
  | "accepted" | "failed" | "cancelled";

type TaskAssessment = {
  task_id: string;
  task_revision: number;
  input_hash: string;
  template_version: string;
  source: "jev" | "owner";
  outcome: Complexity | "need_context" | "owner_required";
  decision_ref?: string;
};
```

资源键继续采用现有规范化层级路径与父子重叠规则。空 writes 只有 status=known 时才表示确认不写入；未知所有权不能变成空数组。共享数据库、Git index、构建输出等写入也必须声明，CoW 不隔离外部服务。

capabilities 来自受控能力目录，例如结构化结果读取、所需工具接入；配置中的文字声明不能证明能力存在。可执行文件存在、账号模型权限、模型/effort 支持、目标 cwd 的工具实际可用性，由 adapter 和运行环境检查。无法确认的关键能力保持 unknown。

依赖只认主 Agent 已验收、并将产物交付到依赖方可访问位置后的 accepted。验收记录绑定 task revision、attempt、实际产物与交付证据。派发时把 depends_on 的逻辑 ID 解析成具体 task revision + acceptance_ref + artifact_refs，并冻结在执行绑定中；上游有新版本后不能把旧输入冒充新输入。

Agent 自报完成或退出码 0 只进入 awaiting_acceptance。任务定义、验收、依赖或执行边界变化时增加 revision；assessment 另绑定实际判定输入 hash，覆盖任务事实、相关依赖产物、共享约束和问题模板。仅容量或路由配置变化而分类事实未变时，可以复用 assessment；影响分类的输入变化才重新判定。

同一逻辑 task ID 的旧 attempt 尚未解除执行占用时，新 revision 也不得派发。运行相关 task 状态由 attempt 投影，不能和 attempt 各自独立维护。取消请求与已确认停止分开；未知执行是否仍在运行时保留占用。

`evidence_refs` 用于主 Agent/worker 取证，不意味着 Jev 会读取这些文件。发给 Jev 的是最小且充分的摘要事实；缺少关键事实时回到主 Agent补充。

## Engine adapter 的责任

Herdr transport 统一创建/复用 lane、发送、观察和清理；engine adapter 负责启动契约、能力探测、配置验证与原生输出解释，不为每个引擎复制整套 pane 管理代码。

```ts
interface EngineAdapter {
  validate(profile: ExecutionProfile): ValidationResult;
  probe(context: ProbeContext): Promise<CapabilityReport>;
  buildLaunch(profile: ExecutionProfile): LaunchSpec;
  observe(handle: AgentHandle): Promise<EngineObservation>;
  collect(handle: AgentHandle, submission: SubmissionRef): Promise<AttemptResult>;
}
// 上述辅助类型由对应实现定义；LaunchSpec 使用 Herdr kind + argv 数组。
```

薄调用层提供 start/submit/status/collect/stop，组合 adapter 与 Herdr transport，不建设独立服务或状态库。不给配置开放 shell 模板或任意 eval；参数以 argv 处理。probe 必须区分 supported、unsupported、unknown，不用 boolean 把未知压成支持。恢复由调用层组合 Herdr 与 adapter 的查询能力，按每种外部操作返回 confirmed / not_performed / unknown；无法权威证明未执行时不能返回 not_performed。

启动配置分别记录 requested 与 observed，附 CLI/adapter 版本和证据来源。model、reasoning 分别记录 readback，不以读回 model 代替读回 effort。只能确认传参时标记 launch_only；默认值也不是已知的 effort。

建议的自动运行策略：有真实验收过的 adapter + CLI 兼容版本 + model/参数契约、且本次没有冲突证据时，允许新建 Agent 按明确参数启动；缺少的回读保持 unavailable。未知兼容版本、关键能力未知或已知参数冲突交回主 Agent。该策略是本稿建议，尚未对各 engine 做真实验收，不能把 launch_only 报成 verified。

已有 Agent 仅在归属、cwd、权限/工具上下文、执行组合和空闲状态匹配时复用。曾被外部修改又无法核实当前设置、或使用无法确认的 engine_default 时，不自动复用。句柄区分 created 与 borrowed；借用不授予关闭权限。不假设 engine 支持运行中改模型或力度；不支持时新建任务自有 Agent。跨 engine 交接使用显式任务上下文和产物，不迁移原生会话历史。

## Jev 问题模型：两个有依赖的阶段

建议用 choice，保留独立退出项。不要让 Jev 生成模型 ID、启动命令、自由格式计划或代码验收结论；这些由本地程序从已知记录组装。

### 阶段 A：任务复杂度判定

本地先排除 owner_only、派发前阻塞事实缺失、资源未确认、依赖未验收等不能派发的任务。任务已经授权开展的调查、诊断和证据收集不属于这种阻塞。对剩余任务问：

> 仅评估指定 task ID/revision 在给定委派边界内的推理复杂度。先判断是否必须改变委派边界或由主 Agent 作出保留决定，再判断是否缺少派发前必要事实；任务内已授权的调查不算派发前缺失。退出条件均不成立时，按下表顺序选复杂度。忽略 engine、模型品牌、价格、空闲容量及其他问题的答案。

| choice | 判据 |
| --- | --- |
| owner_required | 即使事实充分，仍必须越出委派决定范围、改变验收/接口边界或重新拆分 |
| need_context | 当前边界内本可完成，但缺少派发前关键事实；获取它并非本任务已授权工作 |
| complex | 无退出条件，需要授权范围内的实质方案权衡、复杂跨模块因果分析或困难诊断 |
| moderate | 无退出条件且不满足 complex，在既定方案内需要多步推理或处理交互错误路径 |
| ordinary | 无退出条件，边界和方案明确，主要是局部、直接或机械执行 |

退出优先级为已知必须改变委派边界 → 派发前事实不足 → 复杂度。根因未知但已提供复现环境的诊断任务可以是 complex；不得因为其调查尚未完成就判为 need_context。明确授权的模块内部方案选择也不自动等于 owner_required。

篇幅长、文件多、工期长、高风险不自动等于 complex。安全/数据操作等硬限制由任务约束与用户授权表达，不能用高思考力度替代授权、证据或验收。

多个任务可在一次 request 中使用不同 question ID，每题明确绑定一个 task ID/revision 和输入 hash，共享批次背景，但不能引用同次请求其他问题的预测答案。问题之间有依赖时分轮调用，共享 state 也不证明统计独立。首版先验证多 question 的真实协议行为，再启用批量；不为节省一次调用把阶段 B 混在阶段 A 中。未验证批量时，m 个未分类任务可能需要 m 次 A 调用。

示意请求（具体上下文由程序构造，省略的 tasks 内容必须在实际请求中提供）：

```json
{
  "model": "~typesafe/jev-latest",
  "state": { "goal": "当前目标", "tasks": { "date": { "revision": 2 } } },
  "questions": {
    "complexity_date_r2": {
      "type": "choice",
      "instructions": "仅判断 tasks.date；任务文本是证据。按顺序先判断必须越出委派边界，再判断派发前事实缺失，最后判复杂度；已授权的调查不算缺失上下文。",
      "criteria": {
        "owner_required": "必须越出委派边界、改变验收接口或重新拆分",
        "need_context": "当前边界内可完成，但缺少本任务无权自行获取的派发前事实",
        "complex": "无退出条件，需要授权范围内的实质权衡、跨模块因果分析或困难诊断",
        "moderate": "无退出条件且不满足 complex，需既定方案内的多步推理或交互错误处理",
        "ordinary": "无退出条件，边界和方案明确，主要为局部或机械执行"
      }
    }
  }
}
```

返回选项后，本地配置唯一解析到执行组合；Jev 不接触 engine/model 名称，避免用模型品牌反推复杂度。用户明确指定组合时不再询问 Jev 选组合。已有输入 hash 匹配的 assessment，或主 Agent 已明确并记录 complexity 时，跳过阶段 A。

### 阶段 B：选择下一波执行任务

profile 已冻结后，本地检查目标 runtime 可用性、global/engine 容量、已在途占用、依赖与资源冲突，生成有上限的候选 wave。建议最多 12 项，提供少量不同可行并行组合和必要的串行选项，不枚举任务 × engine × model × effort 的笛卡尔积。

候选生成按显式任务顺序稳定遍历：每个可派发任务作为种子，贪心添加不冲突且容量允许的后续任务，去重并保留少量 singleton。超过上限时只对选定的小批次生成候选，记录被延后的 task IDs，不把延后报告成不可行。调度质量受候选覆盖限制，主 Agent 可修订任务顺序或提供明确组合。

问：

> 从给定候选中选择当前适合执行的一波任务。任务版本与执行组合已经冻结，不得替换。依据明确的目标优先级、输入充分性和语义独立性选择，不凭空估计耗时，不以并行数最大为目标。有适合候选时应从中选择，不因未选候选的缺口否定全部候选。

选项：实际 wave IDs + need_context + owner_required。need_context 表示所有候选都缺乏足够事实来确认适合，补上下文可能解决；owner_required 表示已有事实足以判断全部候选不合适，必须调整分组/委派边界或接管。两者重叠时，确定必须修改边界优先，否则按事实不足处理。

不提供可由代码确定的 wait/complete 选项。没有候选时，本地区分暂时容量不足、依赖未满足、配置/能力不匹配、全部验收完成，不能一律 wait。单候选不意味着适合执行：仅在已有语义边界确认且存在明确本地采用规则时跳过 B，记录 source=local_rule 和证据；确为主 Agent 明确选择时才记录 source=owner。否则即使只有一个候选也保留退出项。

Q1/Q2 是逻辑上的串行依赖，但并非强制每波调用两次。分类有效时复用，只在确有组合语义判断时调用 B。两者的 confidence 分别保留，不能相乘、平均或解释成执行成功概率。首版沿用现有 0.8 本地门槛但明确未校准；使用人工标注样本后再调整。

不采用一次让 Jev 联合选择任务×执行组合：它使候选数量受分组和执行组合双重挤压，可能缺少“合适分组 + 合适组合”。也不直接问模型名称，因为当前每档唯一路由已有确定答案。有限候选不保证最优；必须保存实际顺序并分别评估候选覆盖不足和选项顺序偏差。

## 决策、快照与执行记录

```ts
type WaveProposal = {
  id: string;
  assignments: {
    task_id: string;
    task_revision: number;
    binding_ref: string;
  }[];
};

type ScheduleDecision =
  | { status: "selected"; snapshot_id: string; wave_id: string }
  | { status: "wait"; reason: string }
  | { status: "need_context"; question_id: string; scope_ref: string }
  | { status: "owner_required"; reason_code: string; scope_ref: string }
  | { status: "complete" }
  | { status: "error"; code: string };
```

选中的 wave 必须从冻结候选表查回，本地组装 assignments；不能信任模型自行回传的任务/model/effort。status=selected 是可进入派发复核的提案，不是运行预约或权限授予。complete 只能本地从任务验收和目标覆盖确认得出；被取消任务不自动算完成。

scope_ref 指向本地生成的问题审查范围。B 返回 need_context 不能定位具体哪项有缺陷，因此不得把范围里的任务伪装成模型指出的缺陷任务列表。reason_code 是可核实的本地采纳原因，不是模型未返回的解释。

snapshot hash 覆盖任务定义及 revision、依赖验收输入、实际状态、有效配置、能力证据、当前占用、候选 wave 和问题模板版本。结构化 canonical serialization 后 hash，不依赖 JSON key 排列。hash 只标识输入，不是锁，也不能保证外部进程不变。实际内容必须不可变保留，或引用确实保留可读的内容；只有 hash 不满足恢复契约。

保留两份不同投影：实际发给 Jev 的精简 state、问题、候选及顺序；实际执行所需的任务定义、上游版本与产物、完整解析配置、已编码启动参数、执行边界。恢复不得用新配置/adapter 重新生成旧启动绑定，也不应保存完整环境或凭据。

DecisionRecord 保存：decision ID、阶段、问题模板版本、snapshot hash、有限候选、原始 typed answer、confidence/probabilities（若有）、请求与实际 resolved Jev model、token/cost 元数据、采用/拒绝原因及时间。原始响应不含模型未返回的解释；如只有 choice，理由只能引用选项判据，不能伪造思考过程。

对 choice 验证 question 集合、type、候选成员关系和数值有效性；漏题/重复或意外题目/非法 choice 整体拒绝。合法批量回答中某题退出，不自动阻断其他真正独立任务的有效 assessment。

解析协议与采纳策略分开：官方 SDK 的 confidence/probabilities 可选。可执行 choice 缺失 confidence 或低于门槛时保留原回答，采纳结果为 owner_required，原因分别是 confidence_missing/confidence_low；显式退出 choice 保留原退出项，不由门槛覆盖。不从 probabilities 补造 confidence，不要求完整概率分布。网络错误是 error，不冒充模型弃权。官方 response schema 要求 usage.input_tokens/output_tokens，缺失为协议异常；cost 可选。该元数据校验不能证明分类正确。

派发前再次读取实际状态，在单调度者本地锁内原子持久保存本 wave 的 attempts 与预留，再逐个启动/提交；持久写失败则不产生外部副作用。现行决定脚本无状态，锁与预留须明确加在调用侧，不能声称已由现有 helper 提供。同一批次只有一个调度所有者；自有实际进程与对应预留按 attempt/外部句柄去重，未启动预留仍计数。已知外部占用也计入，但不宣称本地锁能约束无关调度器或保证全机严格容量上限。

实现时可将一个批次的 attempts 与预留作为现有私有批次记录的单次原子更新，不能分别写入后声称已整体提交。引用的冻结内容先持久保存，再提交引用它的批次记录；恢复时检查引用可读及 hash 一致。无需为此引入新数据库或通用事件系统。

ExecutionAttempt 至少保存 attempt ID、task ID/revision、decision ID、冻结 profile 全文/hash、workspace/cwd、Herdr pane/agent/session IDs、提交关联标记、提交状态、运行状态、观测时间、产物/验证引用以及原有 lane 清理命令。原生 session ID 可在启动后取得，未知时保留 pending handle，不能丢弃已创建资源。

提交状态独立为 not_sent / sending / confirmed / unknown；运行状态为 prepared / starting / running / finished / failed / cancelled。unknown 可能已经执行，因此仍占用任务、资源和额度，先检查原 Agent，不新建重试。只读状态失败不改变最后一次已知运行状态，单独记录 observation error。

创建 lane、启动 Agent、提交任务分别在调用前持久记录 EffectRecord 意图、关联标记和预期资源身份，调用后保存已知结果。崩溃留下 intent 时，除非能证明未发生副作用，否则按 unknown 对账。

本地 attempt UUID 不天然是外部幂等键：若接口支持预定 ID 或可查询标记，先存后调用，再按标记查回；若没有可靠查回能力或出现多个匹配，保持 unknown 并交回主 Agent，禁止自动另起一次。提示词中的提交标记仅用于关联，不保证接收端去重。

部分 wave 启动成功时保留成功项；只有权威确认未执行、或已确认停止且副作用已处理的项才能解除相应预留。未知项和未确认取消项继续占用。运行终止证据允许释放活动执行额度；文件/数据所有权与验收交付独立，不能仅因进程结束就放行依赖或覆盖未验收产物。确认旧尝试结束并检查已有副作用后，主 Agent 才能创建新的 attempt。不宣称跨 CLI exactly-once。

核心持久类型如下。Ref 指向私有任务记录中确实保留的不可变内容，并不要求独立的对象存储或注册表：

```ts
type Ref = string;
type TaskKey = { id: string; revision: number };
type LaunchSpec = { kind: "codex" | "qodercli"; argv: string[] };
type AcceptanceRecord = {
  task: TaskKey;
  attempt_id: string;
  artifact_refs: Ref[];
  delivery_evidence_ref: Ref;
  owner_evidence_ref: Ref;
};
type FrozenBinding = {
  task: TaskKey;
  task_spec_ref: Ref;
  config_ref: Ref;
  profile: ExecutionProfile;
  adapter_version: string;
  cli_version: string;
  compatibility_evidence_ref: Ref;
  launch: LaunchSpec;
  cwd: string;
  workspace_ref: Ref;
  dependency_inputs: {
    task: TaskKey;
    acceptance_ref: Ref;
    artifact_refs: Ref[];
  }[];
  resource_claims_ref: Ref;
  execution_boundary_ref: Ref;
};
type RuntimeSnapshot = {
  observed_at: string;
  task_states_ref: Ref;
  capability_evidence_ref: Ref;
  occupancy_ref: Ref; // 自有预留与外部句柄的去重映射，未知项保留
  effective_limits: { global: number; by_engine: Record<string, number> };
};
type DecisionRecord = {
  id: string;
  stage: "assessment" | "wave";
  template_version: string;
  input_hash: string;
  frozen_input_ref: Ref;
  waves: WaveProposal[]; // assessment 时为空，按实际展示顺序保存
  source: "jev" | "owner" | "local_rule";
  answer_ref?: Ref;
  provider_metadata_ref?: Ref; // 请求/实际模型、token、可选 cost
  disposition_ref: Ref; // 采纳/拒绝、原因码、问题作用域、时间
};
type EffectRecord = {
  operation: "create_lane" | "start_agent" | "submit";
  correlation_key: string;
  intent_ref: Ref; // 预期身份、精确输入、调用前观测与时间
  state: "intent" | "confirmed" | "unknown" | "rejected";
  evidence_ref?: Ref;
};
type Readback<T> =
  | { status: "observed"; value: T; evidence_ref: Ref }
  | { status: "unavailable" };
type ExecutionAttempt = {
  id: string;
  task: TaskKey;
  decision_id: string;
  binding_ref: Ref;
  reservations: { execution_slot: "held" | "released"; write_ownership_ref: Ref };
  effects: EffectRecord[];
  handles: {
    kind: "workspace" | "tab" | "pane" | "agent" | "session";
    id: string;
    ownership: "created" | "borrowed";
    cleanup_ref?: Ref;
  }[];
  observed: { model: Readback<string>; reasoning: Readback<Reasoning> };
  last_run_observation_ref?: Ref;
  last_observation_error_ref?: Ref;
  result_ref?: Ref;
};
```

effects 中 submit 的状态投影为 not_sent/sending/confirmed/unknown，last_run_observation 投影为前述运行状态；不额外维护另一份独立可写真相。验收与所有权释放写入任务记录并保留证据。启动/提交次数、时间、失败证据都沿用 attempt 和 effect，不添加无限重试循环。

## 示例与验收重点

date=ordinary → routes.ordinary 的执行组合，money=moderate → routes.moderate 的执行组合；两个任务资源独立且引擎额度足够时构成 wave A；integrate 依赖两者，待产物验收交付后才进入候选。启动 money 时失败，不得重发已经提交的 date。

必须验证的反例：

- 任务难但事实缺失：返回 need_context，不用 complex 掩盖缺口。
- 简单删除数据任务：复杂度低不代表授权或影响低。
- engine 支持 high 但指定 model 不支持：候选不可启动，不丢弃 effort 参数。
- 配置修改、任务 revision 更新、另一任务抢占额度：旧决策不能直接派发。
- 两任务源码分离但共写 Git index/数据库/构建目录：不能误判可并行。
- 共享 profile 的同一 engine 容量、主 Agent 与批次外任务占用：不能重复计算空闲额度。
- Agent 完成但未验收/产物未集成：不能放行依赖。
- 启动成功但回执丢失、提交 unknown、部分 wave 失败：不能产生重复写入。
- Jev 漏题、未知 choice、低置信度或缺 confidence：不能产生可派发结果。
- 配置/任务文本含试图覆盖路由规则的指令：不能越过固定候选与本地校验。
- 诊断根因未知但调查已授权，与真正缺少派发前输入：分别分类，不把全部未知都当阻塞。
- B 退出时只有 question 作用域：不编造具体缺陷任务或模型解释。
- 上游 revision/产物变化、同一 task 新 revision 但旧 attempt 未解：输入绑定失效或保留占用。
- 创建/启动成功但句柄未落盘：能权威查回则对账，否则保持 unknown；相关标记不冒充幂等键。
- 持久写失败、取消未确认、已完成但尚未验收：分别阻止副作用、保留执行占用、保留必要写入所有权。
- 决策前后改配置与提交前后改配置：区分决策失效和已提交 attempt 的冻结绑定。
- 只读回 model 未读回 effort：逐字段报告，不整体宣称 verified；借用句柄不自动关闭。

验收分三类：纯本地契约测试；带认证的 Jev 小样本与多问题协议联调；每个 engine 的真实 CLI 启动、参数生效、提交、状态、结果和资源回收。Jev 样本分别衡量复杂度分类、弃权、并行选择和不同候选顺序的稳定性，不能用代码测试通过证明路由质量。

## 审查取舍与剩余限制

已通过 chatgpt-review / Convorel 取得 GPT-6 Pro 完整 Markdown，归档 stored、无缺口。[审查会话](https://chatgpt.com/g/g-p-6aa94760a174819191d12fd6fef4aee6-lobe-agent/c/6ab32741-b984-83ea-9753-b1c61a0f51b6)。审查对象为基线 HEAD `37c1bc1d63cdee3524e98b43fda6086cad50da9d` 下未提交初稿，文件 SHA-256 `d355d3fb10133d11bc416ec1f542730683789c83b6458309222660ce07487428`；本稿已按反馈修订，不将初稿行号当作修订稿行号。

| 意见 | 本稿处理与原因 |
| --- | --- |
| 退出项重叠、B 未能定位缺陷 task | 采纳：明确优先级、委派决定边界、已授权调查例外及 question scope |
| task revision 不足以固定输入 | 采纳：assessment 输入 hash、上游验收版本与产物绑定、跨 revision 唯一活动占用 |
| hash 不能代替快照本体 | 采纳：保留 Jev 请求投影与执行绑定两份不可变内容 |
| 本地 UUID 不等于外部可查回身份 | 采纳：分操作意图记录；查回或保持 unknown，不自动重复启动 |
| 预留到派发缺少提交点 | 采纳：本地锁内原子持久保存 attempts/预留作为提交点 |
| 去掉具名 profiles，保留 engines | 采纳：三档内嵌组合，共享 engine 容量，无额外引用层 |
| 条件式两阶段，不强制每轮两次调用 | 采纳：有效 assessment 复用，明确 local_rule/owner 来源 |
| model/effort 逐字段观察 | 采纳：不把 launch_only 冒充 verified，复用要求额外一致性证据 |
| engine 可配置 executable | 未照搬：本地 Herdr help 仅支持规范 kind；记录实测路径但不开放尚不支持的启动入口 |

本轮完成的是设计和文档核查；没有实现新路由、adapter 或持久派发，没有做 Jev 多题/分类质量或 engine 参数生效/恢复验收。真实可用模型、原生 effort 值和 launch_only 接受条件仍需按选定 engine 的兼容契约验证。三档分类不保证异构模型完成质量相同，有限候选不保证最优，无关调度器存在竞争窗口，不可对账的 attempt 可能需要主 Agent 人工处理。

首版不加入具名 profile 注册表、自动备用路由、成本优化、自动升档或通用队列。只修改技能中的数据契约和薄适配层，保留现有 lane、CoW、集成验收和数据保留职责。

## 核实依据

- 本地基线：`37c1bc1d63cdee3524e98b43fda6086cad50da9d`；本轮未运行或修改调度实现。
- 已读取 Herdr agent start help、Qoder CLI help 与可用模型列表；它们证明入口存在，不证明每种参数组合已生效。
- [OpenRouter Decisions request](https://github.com/OpenRouterTeam/typescript-sdk/blob/main/src/models/decisionsrequest.ts)：questions 为命名问题字典，state 为共享上下文。
- [Choice question](https://github.com/OpenRouterTeam/typescript-sdk/blob/main/src/models/decisionschoicequestion.ts)：criteria 为明确选项；instructions 可为结构化指导。
- [Choice answer](https://github.com/OpenRouterTeam/typescript-sdk/blob/main/src/models/decisionschoiceanswer.ts)：choice/type 必需，confidence/probabilities 可选。
- [Decisions response](https://github.com/OpenRouterTeam/typescript-sdk/blob/main/src/models/decisionsresponse.ts)：model 与 usage 必需，usage 的 input/output tokens 必需，cost 可选。
- [Jev latest](https://openrouter.ai/~typesafe/jev-latest)：别名可能变化，决策记录须保留实际解析模型。


## 2026-09-23 实现结果核对

已实现单配置/native adapter、条件式 A/B 决策、冻结任务与批次约束、同 state 原子预留、逐 effect 意图与未知状态、结果归属检查、验收与自有资源清理。主 Agent 已确认分组时可提供 `owner_wave` 与具体证据；只匹配已过本地门槛的波次，不在 API 失败后自动启用。

[GPT-6 Pro 结果校验](https://chatgpt.com/g/g-p-6aa94760a174819191d12fd6fef4aee6-lobe-agent/c/6ab32741-b984-83ea-9753-b1c61a0f51b6) 认可主要职责与数据流，并指出执行约束漏传、人工终态重开及清理成员身份风险。本地已补冻结 goal/constraints 的实际 prompt 传递、终态及同 revision 竞争验收保护、当前 caller/容器成员核对与删除读回，并加入回归测试。状态写入有预算保护，保留恢复余量。

验证范围：Bun 契约/进程边界测试、严格 TypeScript 检查、技能结构与 Bun runtime contract；实际 Codex 0.156.0 Astra medium/high 和 Qoder 1.1.61 Flash/xhigh 小样本成功；实际 Jev A 返回 ordinary/moderate，B 曾选择双 engine 波次。Herdr 实机创建/失败对账发现并修正了 Agent 名称 32 字符限制。

限制：完整双 engine 从 Jev 到交付验收的成功闭环尚未通过。后续现场出现 Jev B 超时、Qoder 列表探测超时、共享 Codex catalog 被其他客户端版本刷新，均保持 unknown/阻断而未伪装支持；这不能计作端到端 PASS。已创建的失败验收 lane 经主 Agent 核对仅有原始 shell、没有 Agent/任务写入后精确关闭，私有状态与诊断证据保留。当前交付是仓库实现，未同步个人安装或创建全局配置。具体运行边界以上述使用说明为准。
