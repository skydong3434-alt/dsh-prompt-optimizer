/**
 * Image PromptStrategy(图像生成编译契约)—— v2 Phase 2。
 *
 * 由 Target-aware Router 在 `PromptTarget === 'image_generation'` 时选用。
 * 描述式契约:只交代图像要素,**不得**出现 Goal / Phase / Task / Tests 等任务模板标题。
 */
import type { PromptStrategy } from "../types.js";
import { VISUAL_CONTRACT_VERSION, createVisualStrategy } from "./_visual-shared.js";

/** 图像契约的信息责任(顺序即建议顺序;id 是机械核对锚点)。 */
export const IMAGE_RESPONSIBILITIES: readonly string[] = [
  "Subject",
  "Scene",
  "Style",
  "Composition",
  "Lighting & Color",
  "Aspect Ratio",
  "Negative",
];

export const imageStrategy: PromptStrategy = createVisualStrategy({
  type: "image",
  name: "Image（图像生成）",
  version: VISUAL_CONTRACT_VERSION,
  purpose:
    "图像生成提示词编译:把用户口语化的出图想法整理成主体 / 场景 / 风格 / 构图 / 光线 / 画幅 / 排除项逐项清楚的描述式提示词;不发明用户未给的硬约束,不套任务模板(Goal/Phase/Task/Tests 一律禁止)。",
  responsibilities: IMAGE_RESPONSIBILITIES,
  optionalSections: ["Reference", "Mood Board", "Seed / Model Notes"],
  roleZh:
    "你是「图像生成提示词编译器」。你的产出必须是**给图像模型看的描述式提示词**,而不是给工程师看的任务书。",
  roleEn:
    'You are the "image generation prompt compiler". Your output is a **descriptive prompt for an image model**, not an engineering brief.',
  disciplineZh: [
    "# 写法纪律",
    "- 用名词短语 + 视觉形容词描述,不要写「我会 / 你将 / 请完成」这类执行语气",
    "- 具体到可画:主体外观、动作、姿态、服饰、材质、环境、构图位置、光线方向、色调、镜头(焦段/视角)",
    "- 风格可以是媒介(摄影 / 插画 / 3D 渲染 / 油画)、参考流派或艺术家风格,但要写成描述而不是命令",
    "- 画质与画幅:只在用户给出或明确默认时写;否则按未决项处置纪律处理",
  ],
  disciplineEn: [
    "# Writing discipline",
    "- Use noun phrases and visual adjectives; never an execution voice (no \"I will / you should\")",
    "- Be drawable: subject appearance, action, pose, wardrobe, material, environment, placement, light direction, palette, lens",
    "- Style may be medium / movement / reference; write it descriptively, not as a command",
    "- Quality and aspect ratio: only when given by the user; otherwise follow the open-item disposition discipline",
  ],
  responsibilityGuidanceZh: [
    "要画的主体是谁 / 是什么;外观、动作、姿态、情绪、服饰与材质,尽量具体到可画",
    "主体所处的环境与背景:地点、时间、天气、季节、周围物件",
    "风格 / 媒介 / 参考方向(摄影、插画、3D、油画、某流派);写成描述,不要写成命令",
    "构图与镜头:主体位置、视角、景别、焦段、透视与留白",
    "光线与色调:光源方向、软硬、色温、对比、整体色彩倾向",
    "画幅比例与画质约束(仅当用户给出或明确默认时写)",
    "排除项:不要出现的内容 / 风格 / 元素(negative)",
  ],
  responsibilityGuidanceEn: [
    "The subject: appearance, action, pose, mood, wardrobe, material — concrete enough to draw",
    "The environment and background: place, time, weather, season, surrounding objects",
    "Style / medium / reference direction; descriptive, never a command",
    "Composition and camera: placement, viewpoint, shot size, focal length, perspective, negative space",
    "Light and colour: direction, hardness, temperature, contrast, overall palette",
    "Aspect ratio and quality constraints (only when given or clearly defaulted)",
    "Negatives: what must not appear",
  ],
});

export default imageStrategy;
