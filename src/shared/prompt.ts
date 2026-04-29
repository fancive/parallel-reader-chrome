import type { ProviderSettings } from './types';

const SCHEMA = '{"cards":[{"title":"...","anchor":"...","gist":"...","bullets":["...","..."]}]}';

const EXAMPLE = `{"cards":[
  {"title":"U 型收益曲线","anchor":"那谁又会被 AI 所受益？整体来看","gist":"AI 生产力收益呈 U 型","bullets":["最高薪岗位通过加速既有工作受益最大","最低薪岗位用 AI 开副业创造新收入","中间层科学家、律师收益最少"]}
]}`;

const ENGLISH_EXAMPLE = `{"cards":[
  {"title":"浏览器入口之争","anchor":"Perplexity on Wednesday launched its first AI-powered web browser, called Comet","gist":"AI 浏览器把搜索入口和页面操作整合到同一界面","bullets":["浏览器成为 AI 公司争夺默认入口的新战场","页面侧边助手可以总结、管理标签并执行部分网页任务","隐私和权限边界会直接影响用户信任"]}
]}`;

const ENGLISH_OUTPUT_EXAMPLE = `{"cards":[
  {"title":"Browser entry point","anchor":"Perplexity on Wednesday launched its first AI-powered web browser, called Comet","gist":"AI browsers combine search entry points with page actions.","bullets":["Browser defaults are becoming a strategic AI distribution channel.","Side-panel assistants can summarize pages, manage tabs, and execute simple web tasks.","Privacy and permission boundaries directly shape user trust."]}
]}`;

const LANGUAGE_CONFIG = {
  'zh-CN': {
    outputRule: '除 anchor 外，title/gist/bullets 必须使用简体中文。',
    titleRule: '3-10 字短标题，独立说明这段讲什么，避免"背景""介绍"',
    gistRule: '用简体中文点出该单元的核心立场或结论',
    anchorRule: '如果原文是英文，anchor 必须保持英文原文；title/gist/bullets 必须使用简体中文。',
    example: `${EXAMPLE}\n\n英文文章示例：\n${ENGLISH_EXAMPLE}`,
  },
  en: {
    outputRule: 'Except for anchor, title/gist/bullets must be written in English.',
    titleRule: '3-8 English words, standalone and specific; avoid vague titles like "Background" or "Introduction"',
    gistRule: 'write one English sentence that states the unit stance or conclusion',
    anchorRule: 'anchor must keep the exact source-language text; title/gist/bullets must be written in English.',
    example: ENGLISH_OUTPUT_EXAMPLE,
  },
} as const;

const DENSITY_CONFIG = {
  concise: {
    label: '精简',
    bulletCount: '2-4',
    gistLength: '15-30 字或 8-16 English words',
    bulletLength: '15-35 字或 8-18 English words',
    detailRule: '只保留主线、关键证据和必要机制',
  },
  normal: {
    label: '标准',
    bulletCount: '3-6',
    gistLength: '20-40 字或 10-22 English words',
    bulletLength: '20-50 字或 10-28 English words',
    detailRule: '覆盖主要论点、证据、对比、机制和例子',
  },
  detailed: {
    label: '详细',
    bulletCount: '4-8',
    gistLength: '25-55 字或 14-30 English words',
    bulletLength: '25-70 字或 14-40 English words',
    detailRule: '保留更多限定条件、数据、反例、背景和因果链',
  },
} as const;

export type PromptPair = { system: string; user: string };

export function buildPrompts(content: string, settings: Readonly<ProviderSettings>): PromptPair {
  const minCards = settings.minCards;
  const maxCards = Math.max(minCards, settings.maxCards);
  const language = LANGUAGE_CONFIG[settings.summaryLanguage];
  const density = DENSITY_CONFIG[settings.cardDensity];
  const doc =
    content.length > settings.maxDocChars
      ? `${content.slice(0, settings.maxDocChars)}\n\n[文档过长，已截断]`
      : content;

  const system = `你是一个长文阅读摘要助手。阅读全文后，把文章切成 ${minCards}-${maxCards} 个"自然主题单元"——以"一个完整论点或话题"为单位，短章节合并、长章节拆分。

输出语言：${language.outputRule}
信息密度：${density.label}，每张卡 ${density.bulletCount} 条 bullet，${density.detailRule}。

每张卡片的结构：一句话领读 + 若干条 bullet。bullet 承载细节，gist 是导读。

对每个单元输出：

- title: ${language.titleRule}
- anchor: 该单元开头的**逐字引用**，从原文 1:1 复制 30-60 字，保留原始标点/空格；仅供插件内部定位
- gist: **一句话领读**（${density.gistLength}），${language.gistRule}
- bullets: **${density.bulletCount} 条**支撑 bullet，每条 ${density.bulletLength}，${density.detailRule}。gist 是立场，bullets 是具体内容

anchor 是定位用的机器字段，比摘要质量更重要。生成 anchor 时按这个流程：
1. 先在文档全文里找到该单元开头附近的一段原文。
2. 直接从文档中复制连续 substring，长度 30-90 个字符。
3. 复制后不要改任何字符：不要改大小写、标点、引号、撇号、破折号、空格，不要把 curly quote 改成 straight quote，也不要补词。
4. ${language.anchorRule}
5. 不要用你记忆中的网页内容、常识、标题或改写句作为 anchor。

规则：
- anchor 必须能在上方文档全文中 exact substring match；如果不确定，就选择更短、更靠前、更普通的一段原文
- anchor 选用该单元最靠前且足够独特的一段，避免从标题、导航、作者名、日期、图片说明、广告、推荐阅读中取 anchor
- 每张卡都必须同时有 gist 和 bullets
- 严格只输出 JSON，无 markdown fence、无解释

输出格式：
${SCHEMA}

示例：
${language.example}`;

  const user = `以下是需要处理的文档全文：\n\n${doc}`;
  return { system, user };
}
