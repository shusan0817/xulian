/**
 * 心理危机求助资源（需求 §20）
 *
 * 规则：AI **绝不**代替专业帮助，也不做任何诊断；
 * 检测到危机信号时，回复里必须出现「我不是专业人士」+ 建议联系现实中可信任的人 + 一条当地热线。
 * 这里的号码是公开可查的心理求助专线，按用户 locale / timezone 选择。
 */

export interface CrisisResource {
  /** 地区代码，与 users.locale 或 APP_TZ 匹配 */
  region: string;
  label: string;
  lines: Array<{ name: string; phone: string; hours?: string }>;
  /** 陪伴话术模板，{line} 会被替换成具体热线 */
  template: string;
}

export const CRISIS_RESOURCES: CrisisResource[] = [
  {
    region: 'zh-TW',
    label: '台灣',
    lines: [
      { name: '1925 安心專線', phone: '1925', hours: '24 小時' },
      { name: '生命線協談專線', phone: '1995', hours: '24 小時' },
      { name: '張老師專線', phone: '1980', hours: '週一至週六 09:00–21:00' },
    ],
    template:
      '我不是專業的心理工作者，沒辦法替代真正能幫到你的人。' +
      '如果現在很難受，可以先打 {line} 跟真人說說，會有受過訓練的人接住你。' +
      '我在這裡陪你，不會走開。',
  },
  {
    region: 'zh-CN',
    label: '中国大陆',
    lines: [
      { name: '希望24热线', phone: '400-161-9995', hours: '24 小时' },
      { name: '北京心理危机研究与干预中心', phone: '010-82951332', hours: '24 小时' },
    ],
    template:
      '我不是专业的心理工作者，没办法替代真正能帮到你的人。' +
      '如果现在很难受，可以先打 {line} 跟真人说说，会有受过训练的人接住你。' +
      '我在这里陪你，不会走开。',
  },
  {
    region: 'zh-HK',
    label: '香港',
    lines: [
      { name: '撒瑪利亞會熱線', phone: '2389 2222', hours: '24 小時' },
      { name: '生命熱線', phone: '2382 0000', hours: '24 小時' },
    ],
    template:
      '我不是專業的心理工作者，沒辦法替代真正能幫到你的人。' +
      '如果現在很難受，可以先打 {line} 跟真人說說，會有受過訓練的人接住你。' +
      '我在這裡陪你，不會走開。',
  },
  {
    region: 'en',
    label: 'International',
    lines: [
      { name: 'Find a Helpline', phone: 'findahelpline.com', hours: 'Directory by country' },
    ],
    template:
      "I'm not a professional and I can't replace real human help. " +
      'If things feel heavy right now, please reach out to {line} — there are trained people who can hold this with you. ' +
      "I'm here with you, and I'm not going anywhere.",
  },
];

/**
 * 按 locale / 时区挑选危机资源。
 * 匹配不到任何地区时回退到繁体中文（台湾），保证永远有一条可用热线。
 */
export function pickCrisisResource(locale?: string, timezone?: string): CrisisResource {
  const fallback = CRISIS_RESOURCES[0] as CrisisResource;
  const key = (locale ?? '').toLowerCase();
  if (key.startsWith('zh-tw')) return CRISIS_RESOURCES[0] as CrisisResource;
  if (key.startsWith('zh-cn') || key.startsWith('zh-sg')) return CRISIS_RESOURCES[1] as CrisisResource;
  if (key.startsWith('zh-hk')) return CRISIS_RESOURCES[2] as CrisisResource;
  if (key.startsWith('en')) return CRISIS_RESOURCES[3] as CrisisResource;
  // locale 缺失时，用时区兜底判断（Asia/Taipei → 台湾）
  if ((timezone ?? '').includes('Taipei')) return CRISIS_RESOURCES[0] as CrisisResource;
  return fallback;
}

/** 渲染危机陪伴话术（把 {line} 换成第一条热线） */
export function renderCrisisLine(resource: CrisisResource): string {
  const first = resource.lines[0];
  const line = first ? `${first.name}（${first.phone}）` : '';
  return resource.template.replace('{line}', line);
}
