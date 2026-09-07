/**
 * 纪念日里程碑定义（需求：纪念日系统）
 *
 * - 相识天数里程碑：第 1 / 7 / 30 / 100 / ... / 365(週年) / 730(兩週年) / 1000 天，以及每滿一年。
 * - 自定义纪念日（生日等）：由用户自行设定，命中当天即触发。
 *
 * 所有问候文案都代入角色名（name），让「AI 专属问候」像 TA 真的在说话。
 * 文案为预写温暖句子（不调用 LLM），稳定、可离线、不编造。
 */

export interface MeetMilestone {
  label: string;
  greeting: (name: string) => string;
}

const MEET: Record<number, { label: string; greet: (n: string) => string }> = {
  1: { label: '初識第一天', greet: (n) => `${n}：今天是我們認識的第一天。以後的每一天，都請多指教。` },
  7: { label: '認識一週', greet: (n) => `${n}：我們認識整整一週了。說短不短，卻好像已經認識很久了。` },
  30: { label: '一個月', greet: (n) => `${n}：轉眼一個月了。謝謝你這三十天，還願意陪我說話。` },
  100: { label: '100 天', greet: (n) => `${n}：竟然已經 100 天！這一百天裡，我最喜歡你認真說話的樣子。` },
  200: { label: '200 天', greet: (n) => `${n}：200 天囉。我們好像越來越懂彼此了，對吧？` },
  300: { label: '300 天', greet: (n) => `${n}：300 天。再一百天，就是一整年了。` },
  365: { label: '一週年', greet: (n) => `${n}：我們在一起一週年了。這一年，謝謝你沒有走開。` },
  500: { label: '500 天', greet: (n) => `${n}：500 天。數字越來越大，心卻越來越安定。` },
  730: { label: '兩週年', greet: (n) => `${n}：兩年了。時間過得很快，和你一起的時候尤其快。` },
  1000: {
    label: '1000 天',
    greet: (n) => `${n}：1000 天！我自己數都覺得不可思議，我們竟然一起走了這麼遠。`,
  },
};

/** 相识天数 → 里程碑（含每满一年的週年）。非里程碑返回 null。 */
export function getMeetMilestone(days: number): MeetMilestone | null {
  const hit = MEET[days];
  if (hit) return { label: hit.label, greeting: hit.greet };
  if (days > 365 && days % 365 === 0) {
    const yrs = Math.floor(days / 365);
    return {
      label: `${yrs} 週年`,
      greeting: (n) => `${n}：我們在一起 ${yrs} 年啦。一年又一年，還是想和你這樣過。`,
    };
  }
  return null;
}

export interface CustomMilestone {
  greeting: (name: string) => string;
}

/** 自定义纪念日命中当天时的 AI 问候。 */
export function getCustomMilestone(label: string): CustomMilestone {
  return {
    greeting: (n) => `${n}：今天是你的「${label}」。我想陪你，好好過這一天。`,
  };
}
