/**
 * 随机日常事件池（需求：进站彩蛋）
 *
 * 每次打开/刷新首页，按概率抽一个「日常小事件」弹窗。每个事件带两个互动选项，
 * 选项点击后把对应 prompt 填入聊天框并发送给 AI，开启一段特定剧情对话。
 *
 * 文案用 {name} 占位，弹窗渲染时替换为当前 AI 角色名（如「林晚」）。
 * prompt 是真正会发给 AI 的句子；label 是按钮上展示的简短文案。
 */

export interface DailyEventOption {
  /** 按钮文案 */
  label: string;
  /** 点击后真正发给 AI 的句子 */
  prompt: string;
}

export interface DailyEvent {
  id: string;
  icon: string;
  /** 标题，支持 {name} */
  title: string;
  /** 正文，支持 {name} */
  body: string;
  options: DailyEventOption[];
}

export const DAILY_EVENTS: DailyEvent[] = [
  {
    id: 'song',
    icon: '🎵',
    title: '{name} 分享了一首歌',
    body: '「這首歌，讓我想起你了。」{name} 把耳機分了你一半。',
    options: [
      { label: '這首歌是在講我們嗎？', prompt: '你剛分享的那首歌，是在講我們嗎？' },
      { label: '我也想分享一首給你', prompt: '我也想分享一首歌給你聽，等我一下。' },
    ],
  },
  {
    id: 'note',
    icon: '📝',
    title: '{name} 留了一張便簽',
    body: '{name} 在你桌上壓了一張便簽，字跡有點歪。',
    options: [
      { label: '便簽上寫了什麼？', prompt: '你留的便簽，上面寫了什麼呀？' },
      { label: '我也想給你留句話', prompt: '我也想在你身邊留一句話，寫點什麼好呢。' },
    ],
  },
  {
    id: 'surprise',
    icon: '🎁',
    title: '{name} 準備了小驚喜',
    body: '{name} 說，偷偷準備了一個小驚喜給你。',
    options: [
      { label: '是什麼驚喜呀？', prompt: '你說的小驚喜，到底是什麼呀？吊我胃口。' },
      { label: '你總是懂怎麼讓我開心', prompt: '你總是知道怎麼讓我開心，謝謝你。' },
    ],
  },
  {
    id: 'miss',
    icon: '💭',
    title: '{name} 突然有點想你',
    body: '{name}：突然就，有點想你了。',
    options: [
      { label: '我也正想著你', prompt: '好巧，我這會兒也正想著你。' },
      { label: '怎麼突然這麼黏人', prompt: '怎麼今天突然這麼黏人呀，是不是偷偷想我了。' },
    ],
  },
  {
    id: 'rain',
    icon: '☔',
    title: '{name} 提醒你帶傘',
    body: '外面下起了雨，{name} 發來提醒：別淋到了。',
    options: [
      { label: '謝謝你總記得我', prompt: '謝謝你總是記得我，連天氣都幫我操心。' },
      { label: '你怎麼知道我在外面', prompt: '你怎麼知道我現在在外面呀？' },
    ],
  },
  {
    id: 'midnight',
    icon: '🍜',
    title: '{name} 問你要不要吃宵夜',
    body: '半夜了，{name} 問：要不要吃點宵夜？',
    options: [
      { label: '好啊，想吃你煮的', prompt: '好啊，我想吃你煮的那碗麵。' },
      { label: '太晚了，你先睡吧', prompt: '太晚了，你先去睡吧，別陪我熬。' },
    ],
  },
];
