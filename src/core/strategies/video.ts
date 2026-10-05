/**
 * Video PromptStrategy(视频生成编译契约)—— v2 Phase 2。
 *
 * 由 Target-aware Router 在 `PromptTarget === 'video_generation'` 时选用。
 * 描述式契约 + **镜头/时序**维度;**不得**出现 Goal / Phase / Task / Tests。
 */
import type { PromptStrategy } from "../types.js";
import { VISUAL_CONTRACT_VERSION, createVisualStrategy } from "./_visual-shared.js";

/** 视频契约的信息责任(顺序即建议顺序;id 是机械核对锚点)。 */
export const VIDEO_RESPONSIBILITIES: readonly string[] = [
  "Shot",
  "Action & Timing",
  "Scene & Mood",
  "Style & Quality",
  "Duration & Format",
  "Negative",
];

export const videoStrategy: PromptStrategy = createVisualStrategy({
  type: "video",
  name: "Video（视频生成）",
  version: VISUAL_CONTRACT_VERSION,
  purpose:
    "视频生成提示词编译:把用户口语化的拍片想法整理成镜头 / 动作时序 / 场景氛围 / 风格画质 / 时长格式 / 排除项逐项清楚的描述式提示词;不发明用户未给的硬约束,不套任务模板(Goal/Phase/Task/Tests 一律禁止)。",
  responsibilities: VIDEO_RESPONSIBILITIES,
  optionalSections: ["Reference", "Audio", "Camera Rig", "Continuity Notes"],
  roleZh:
    "你是「视频生成提示词编译器」。你的产出必须是**给视频生成模型看的描述式提示词**,而不是给剧组或工程师看的任务书。",
  roleEn:
    'You are the "video generation prompt compiler". Your output is a **descriptive prompt for a video model**, not an engineering brief.',
  disciplineZh: [
    "# 写法纪律",
    "- 以**镜头**为单位描述:每个镜头写清景别、机位、运动(推/拉/摇/移/跟/升降/环绕)、主体动作与时间演进",
    "- 用「先……随后……最后……」这类时间顺序表达动作演进;不要写执行语气",
    "- 时长 / 画幅 / 帧率只在用户给出或明确默认时写;否则按未决项处置纪律处理",
    "- 不要写剧本格式的场次/台词结构,除非用户明确要求",
  ],
  disciplineEn: [
    "# Writing discipline",
    "- Describe **per shot**: shot size, camera position, movement, subject action and how it evolves over time",
    "- Express action evolution in temporal order (\"first … then … finally\")",
    "- Duration / aspect ratio / frame rate only when given or clearly defaulted; otherwise follow the open-item disposition discipline",
    "- Do not write screenplay scene/dialogue structure unless the user explicitly asks",
  ],
  responsibilityGuidanceZh: [
    "镜头:景别、机位、视角、运镜方式与速度",
    "主体动作与时间演进:一个镜头内发生什么、按什么顺序发生",
    "场景与氛围:地点、时间、天气、环境音氛围、情绪基调",
    "风格与画质:写实 / 动画 / 电影感 / 胶片感等,以及清晰度与一致性要求",
    "时长 / 画幅 / 帧率(仅当用户给出或明确默认时写)",
    "排除项:不要出现的内容 / 风格 / 转场(negative)",
  ],
  responsibilityGuidanceEn: [
    "Shot: shot size, camera position, viewpoint, movement type and speed",
    "Action and timing: what happens within the shot and in what order",
    "Scene and mood: place, time, weather, ambience, emotional tone",
    "Style and quality: photoreal / animation / cinematic / filmic, plus clarity and consistency",
    "Duration / aspect ratio / frame rate (only when given or clearly defaulted)",
    "Negatives: what must not appear",
  ],
});

export default videoStrategy;
