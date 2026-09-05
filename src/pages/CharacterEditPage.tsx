/**
 * 角色创建 / 编辑页（需求 §17）
 *
 * 字段分组与需求一一对应：
 *   基础信息（名称、头像）
 *   人格（性格、说话风格、兴趣、喜欢的话题、不喜欢的话题）
 *   情绪（初始情绪、情绪敏感程度）
 *   互动（主动聊天程度、回复长度、AI 怎么称呼用户）
 *   关系（关系类型、初始关系阶段）
 *
 * 首次创建时先让用户选预设模板（降低门槛），
 * 选完仍可逐项修改——预设只是起点，不是牢笼。
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { AppHeader } from '@/components/common/AppHeader';
import { Avatar } from '@/components/common/Avatar';
import { Button } from '@/components/common/Button';
import { Input, Textarea } from '@/components/common/Input';
import { useAppState } from '@/hooks/useAppState';
import { apiGet, apiPatch, apiPost, humanizeError } from '@/api/client';
import {
  AVATAR_EMOJIS,
  AVATAR_GRADIENTS,
  EMOTION_LIST,
  RELATIONSHIP_STAGES,
  RELATIONSHIP_TYPE_LABELS,
  RELATIONSHIP_TYPES,
  REPLY_LENGTHS,
  REPLY_LENGTH_LABELS,
  STAGE_META,
} from '@shared/constants';
import type {
  EmotionType,
  RelationshipStage,
  RelationshipType,
  ReplyLength,
} from '@shared/constants';
import type { AvatarSpec } from '@shared/types';

interface PresetItem {
  key: string;
  label: string;
  intro: string;
  name: string;
  avatar: AvatarSpec;
}

export function CharacterEditPage(): React.ReactElement {
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const isEdit = Boolean(id);
  const { refresh } = useAppState();

  const [presets, setPresets] = useState<PresetItem[]>([]);
  const [pickedPreset, setPickedPreset] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<AvatarSpec>({
    kind: 'emoji',
    value: AVATAR_EMOJIS[0],
    bg: AVATAR_GRADIENTS[0],
  });
  const [personality, setPersonality] = useState('');
  const [speakingStyle, setSpeakingStyle] = useState('');
  const [interests, setInterests] = useState('');
  const [likedTopics, setLikedTopics] = useState('');
  const [dislikedTopics, setDislikedTopics] = useState('');
  const [initialEmotion, setInitialEmotion] = useState<EmotionType>('calm');
  const [emotionSensitivity, setEmotionSensitivity] = useState(0.5);
  const [proactivityLevel, setProactivityLevel] = useState(0.5);
  const [replyLength, setReplyLength] = useState<ReplyLength>('medium');
  const [userNickname, setUserNickname] = useState('你');
  const [relationshipType, setRelationshipType] = useState<RelationshipType>('companion');
  const [initialStage, setInitialStage] = useState<RelationshipStage>('stranger');

  // 性格微調滑桿（Phase A P0：让人格定制真正生效）
  const [sliderPlayfulness, setSliderPlayfulness] = useState(0.5);
  const [sliderHumor, setSliderHumor] = useState(0.5);
  const [sliderVerbosity, setSliderVerbosity] = useState(0.5);
  const [sliderProactivity, setSliderProactivity] = useState(0.5);
  const [sliderRationality, setSliderRationality] = useState(0.5);
  const [sliderListening, setSliderListening] = useState(0.5);
  const [customDescription, setCustomDescription] = useState('');

  // 载入预设模板
  useEffect(() => {
    void apiGet<{ presets: PresetItem[] }>('/api/characters/presets')
      .then((res) => setPresets(res.presets ?? []))
      .catch(() => undefined);
  }, []);

  // 编辑模式：载入现有角色
  useEffect(() => {
    if (!id) return;
    void apiGet<Record<string, unknown>>(`/api/characters/${id}`)
      .then((res) => {
        const c = (res.character ?? res) as Record<string, unknown>;
        setName(String(c.name ?? ''));
        if (c.avatar) setAvatar(c.avatar as AvatarSpec);
        setPersonality(String(c.personality ?? ''));
        setSpeakingStyle(String(c.speakingStyle ?? ''));
        setInterests(((c.interests as string[]) ?? []).join('、'));
        setLikedTopics(((c.likedTopics as string[]) ?? []).join('、'));
        setDislikedTopics(((c.dislikedTopics as string[]) ?? []).join('、'));
        setInitialEmotion((c.initialEmotion as EmotionType) ?? 'calm');
        setEmotionSensitivity(Number(c.emotionSensitivity ?? 0.5));
        setProactivityLevel(Number(c.proactivityLevel ?? 0.5));
        setReplyLength((c.replyLength as ReplyLength) ?? 'medium');
        setUserNickname(String(c.userNickname ?? '你'));
        setRelationshipType((c.relationshipType as RelationshipType) ?? 'companion');
        setInitialStage((c.initialStage as RelationshipStage) ?? 'stranger');
        setSliderPlayfulness(Number(c.sliderPlayfulness ?? 0.5));
        setSliderHumor(Number(c.sliderHumor ?? 0.5));
        setSliderVerbosity(Number(c.sliderVerbosity ?? 0.5));
        setSliderProactivity(Number(c.sliderProactivity ?? 0.5));
        setSliderRationality(Number(c.sliderRationality ?? 0.5));
        setSliderListening(Number(c.sliderListening ?? 0.5));
        setCustomDescription(String(c.customDescription ?? ''));
      })
      .catch(() => undefined);
  }, [id]);

  const splitList = (value: string): string[] =>
    value
      .split(/[、,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  const save = async (): Promise<void> => {
    if (!name.trim()) {
      setError('請先給角色取個名字');
      return;
    }
    setSaving(true);
    setError(null);

    const payload = {
      name: name.trim(),
      avatar,
      personality,
      speakingStyle,
      interests: splitList(interests),
      likedTopics: splitList(likedTopics),
      dislikedTopics: splitList(dislikedTopics),
      initialEmotion,
      emotionSensitivity,
      proactivityLevel,
      replyLength,
      userNickname,
      relationshipType,
      initialStage,
      sliderPlayfulness,
      sliderHumor,
      sliderVerbosity,
      sliderProactivity,
      sliderRationality,
      sliderListening,
      customDescription,
    };

    try {
      if (isEdit && id) {
        await apiPatch(`/api/characters/${id}`, payload);
      } else if (pickedPreset) {
        await apiPost('/api/characters', { presetKey: pickedPreset, ...payload });
      } else {
        await apiPost('/api/characters', payload);
      }
      await refresh();
      navigate('/characters');
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setSaving(false);
    }
  };

  // 选预设时把预设的名字/头像/性格带出来（用户可再改）
  const applyPreset = (key: string): void => {
    setPickedPreset(key);
    const preset = presets.find((p) => p.key === key);
    if (!preset) return;
    setName(preset.name);
    setAvatar(preset.avatar);
  };

  const sectionTitle = 'mb-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--xl-sub)]';
  const chipClass = (active: boolean): string =>
    `rounded-full px-3 py-1.5 text-[13px] transition-all active:scale-95 ${
      active
        ? 'bg-[var(--xl-blush)] text-white'
        : 'bg-[var(--xl-mist)] text-[var(--xl-ink)]'
    }`;

  const showPresets = !isEdit && presets.length > 0;

  return (
    <>
      <AppHeader title={isEdit ? '編輯角色' : '建立角色'} showBack />

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 xl-no-scrollbar">
        {/* 预设模板 */}
        {showPresets ? (
          <section>
            <h3 className={sectionTitle}>從範本開始（可再修改）</h3>
            <div className="grid grid-cols-2 gap-2">
              {presets.map((p) => (
                <button
                  key={p.key}
                  onClick={() => applyPreset(p.key)}
                  className={`rounded-2xl p-3 text-left transition-all active:scale-[0.98] ${
                    pickedPreset === p.key
                      ? 'bg-[var(--xl-card)] ring-2 ring-[var(--xl-blush)]'
                      : 'bg-[var(--xl-card)] shadow-[var(--xl-shadow)]'
                  }`}
                >
                  <Avatar spec={p.avatar} name={p.name} size={32} />
                  <p className="mt-1.5 text-[13px] font-medium text-[var(--xl-ink)]">{p.label}</p>
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-[var(--xl-sub)]">
                    {p.intro}
                  </p>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {/* 基础信息 */}
        <section>
          <h3 className={sectionTitle}>基礎資訊</h3>
          <div className="space-y-3 rounded-2xl bg-[var(--xl-card)] p-3 shadow-[var(--xl-shadow)]">
            <Input
              label="名字"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：林晚"
            />

            <div>
              <p className="mb-1.5 text-[12px] text-[var(--xl-sub)]">頭像</p>
              <div className="mb-2 flex items-center gap-3">
                <Avatar spec={avatar} name={name || '需'} size={52} ring />
                <div className="flex flex-wrap gap-1.5">
                  {AVATAR_EMOJIS.slice(0, 8).map((emoji) => (
                    <button
                      key={emoji}
                      onClick={() => setAvatar((prev) => ({ ...prev, value: emoji }))}
                      className={`h-8 w-8 rounded-full text-[16px] ${
                        avatar.value === emoji ? 'ring-2 ring-[var(--xl-blush)]' : ''
                      }`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {AVATAR_GRADIENTS.map((bg, index) => (
                  <button
                    key={index}
                    onClick={() => setAvatar((prev) => ({ ...prev, bg }))}
                    className={`h-7 w-7 rounded-full ${
                      avatar.bg === bg ? 'ring-2 ring-[var(--xl-blush)] ring-offset-1' : ''
                    }`}
                    style={{ backgroundImage: bg }}
                    aria-label={`配色 ${index + 1}`}
                  />
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* 人格 */}
        <section>
          <h3 className={sectionTitle}>人格</h3>
          <div className="space-y-3 rounded-2xl bg-[var(--xl-card)] p-3 shadow-[var(--xl-shadow)]">
            <Textarea
              label="性格"
              rows={3}
              value={personality}
              onChange={(e) => setPersonality(e.target.value)}
              placeholder="例如：溫柔、細心，習慣先把情緒接住再說道理。"
            />
            <Textarea
              label="說話風格"
              rows={2}
              value={speakingStyle}
              onChange={(e) => setSpeakingStyle(e.target.value)}
              placeholder="例如：語氣輕緩，句子偏短，不說教。"
            />
            <Input
              label="興趣（用、分隔）"
              value={interests}
              onChange={(e) => setInterests(e.target.value)}
              placeholder="散步、煮飯、舊書"
            />
            <Input
              label="喜歡聊的話題"
              value={likedTopics}
              onChange={(e) => setLikedTopics(e.target.value)}
              placeholder="今天發生的小事"
            />
            <Input
              label="不喜歡聊的話題"
              value={dislikedTopics}
              onChange={(e) => setDislikedTopics(e.target.value)}
              placeholder="爭吵、被催促"
            />

            {/* 性格微調滑桿：进一步微调人格，与 prompts.ts 的轴标签一致 */}
            <div className="space-y-3 border-t border-[var(--xl-mist)] pt-3">
              <p className={sectionTitle}>性格微調滑桿</p>

              <div>
                <p className="mb-1 text-[12px] text-[var(--xl-sub)]">活潑 ↔ 安靜：{sliderPlayfulness.toFixed(2)}</p>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={sliderPlayfulness}
                  onChange={(e) => setSliderPlayfulness(Number(e.target.value))}
                  className="w-full accent-[var(--xl-blush)]"
                />
              </div>

              <div>
                <p className="mb-1 text-[12px] text-[var(--xl-sub)]">幽默 ↔ 認真：{sliderHumor.toFixed(2)}</p>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={sliderHumor}
                  onChange={(e) => setSliderHumor(Number(e.target.value))}
                  className="w-full accent-[var(--xl-blush)]"
                />
              </div>

              <div>
                <p className="mb-1 text-[12px] text-[var(--xl-sub)]">詳細 ↔ 簡短：{sliderVerbosity.toFixed(2)}</p>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={sliderVerbosity}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setSliderVerbosity(v);
                    setReplyLength(v < 0.34 ? 'short' : v < 0.67 ? 'medium' : 'long');
                  }}
                  className="w-full accent-[var(--xl-blush)]"
                />
              </div>

              <div>
                <p className="mb-1 text-[12px] text-[var(--xl-sub)]">主動 ↔ 安靜：{sliderProactivity.toFixed(2)}</p>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={sliderProactivity}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setSliderProactivity(v);
                    setProactivityLevel(v);
                  }}
                  className="w-full accent-[var(--xl-blush)]"
                />
              </div>

              <div>
                <p className="mb-1 text-[12px] text-[var(--xl-sub)]">理性 ↔ 感性：{sliderRationality.toFixed(2)}</p>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={sliderRationality}
                  onChange={(e) => setSliderRationality(Number(e.target.value))}
                  className="w-full accent-[var(--xl-blush)]"
                />
              </div>

              <div>
                <p className="mb-1 text-[12px] text-[var(--xl-sub)]">傾聽 ↔ 建議：{sliderListening.toFixed(2)}</p>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={sliderListening}
                  onChange={(e) => setSliderListening(Number(e.target.value))}
                  className="w-full accent-[var(--xl-blush)]"
                />
              </div>
            </div>

            <Textarea
              label="你希望 TA 是什麼樣的（額外期望）"
              rows={3}
              value={customDescription}
              onChange={(e) => setCustomDescription(e.target.value)}
              placeholder="例如：你希望 TA 更溫柔、少說教，多聽你說。"
            />
          </div>
        </section>

        {/* 情绪 */}
        <section>
          <h3 className={sectionTitle}>情緒</h3>
          <div className="space-y-3 rounded-2xl bg-[var(--xl-card)] p-3 shadow-[var(--xl-shadow)]">
            <div>
              <p className="mb-1.5 text-[12px] text-[var(--xl-sub)]">初始情緒</p>
              <div className="flex flex-wrap gap-1.5">
                {EMOTION_LIST.map((e) => (
                  <button
                    key={e.emotion}
                    onClick={() => setInitialEmotion(e.emotion)}
                    className={chipClass(initialEmotion === e.emotion)}
                  >
                    {e.icon} {e.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1 text-[12px] text-[var(--xl-sub)]">
                情緒敏感程度：{emotionSensitivity.toFixed(2)}
              </p>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={emotionSensitivity}
                onChange={(e) => setEmotionSensitivity(Number(e.target.value))}
                className="w-full accent-[var(--xl-blush)]"
              />
              <p className="mt-0.5 text-[10px] text-[var(--xl-sub)]/70">
                越高越容易被你的情緒帶動，也越快平復
              </p>
            </div>
          </div>
        </section>

        {/* 互动 */}
        <section>
          <h3 className={sectionTitle}>互動</h3>
          <div className="space-y-3 rounded-2xl bg-[var(--xl-card)] p-3 shadow-[var(--xl-shadow)]">
            <div>
              <p className="mb-1 text-[12px] text-[var(--xl-sub)]">
                主動聊天傾向：{proactivityLevel.toFixed(2)}
              </p>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={proactivityLevel}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setProactivityLevel(v);
                  setSliderProactivity(v);
                }}
                className="w-full accent-[var(--xl-blush)]"
              />
            </div>
            <div>
              <p className="mb-1.5 text-[12px] text-[var(--xl-sub)]">回覆長度</p>
              <div className="flex gap-1.5">
                {REPLY_LENGTHS.map((len) => (
                  <button
                    key={len}
                    onClick={() => {
                      setReplyLength(len);
                      setSliderVerbosity(len === 'short' ? 0.2 : len === 'long' ? 0.8 : 0.5);
                    }}
                    className={chipClass(replyLength === len)}
                  >
                    {REPLY_LENGTH_LABELS[len]}
                  </button>
                ))}
              </div>
            </div>
            <Input
              label="他怎麼稱呼你"
              value={userNickname}
              onChange={(e) => setUserNickname(e.target.value)}
              placeholder="你 / 小名"
            />
          </div>
        </section>

        {/* 关系 */}
        <section>
          <h3 className={sectionTitle}>關係</h3>
          <div className="space-y-3 rounded-2xl bg-[var(--xl-card)] p-3 shadow-[var(--xl-shadow)]">
            <div>
              <p className="mb-1.5 text-[12px] text-[var(--xl-sub)]">關係類型</p>
              <div className="flex flex-wrap gap-1.5">
                {RELATIONSHIP_TYPES.map((t) => (
                  <button
                    key={t}
                    onClick={() => setRelationshipType(t)}
                    className={chipClass(relationshipType === t)}
                  >
                    {RELATIONSHIP_TYPE_LABELS[t]}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-[12px] text-[var(--xl-sub)]">初始關係階段</p>
              <div className="flex flex-wrap gap-1.5">
                {RELATIONSHIP_STAGES.map((s) => (
                  <button
                    key={s}
                    onClick={() => setInitialStage(s)}
                    className={chipClass(initialStage === s)}
                  >
                    {STAGE_META[s].label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {error ? (
          <p className="rounded-xl bg-[var(--xl-blush)]/10 px-3 py-2 text-[13px] text-[var(--xl-blush-deep)]">
            {error}
          </p>
        ) : null}

        <div className="pb-4">
          <Button block size="lg" disabled={saving} onClick={() => void save()}>
            {saving ? '儲存中…' : isEdit ? '儲存變更' : '建立角色'}
          </Button>
        </div>
      </div>
    </>
  );
}

export default CharacterEditPage;
