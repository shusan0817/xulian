/**
 * 日常小事件弹窗（需求：进站彩蛋）
 *
 * 展示一条「TA 主动发生的小事」，带两个互动选项。点击任一选项：把该选项的 prompt
 * 作为消息自动填入聊天框并发送给 AI（经 /chat?c=&auto=，由 ChatPage 自动发出），
 * 开启一段特定剧情对话。
 */

import { useNavigate } from 'react-router-dom';

import { Modal } from '@/components/common/Modal';
import type { DailyEvent } from '@/lib/dailyEvents';

interface DailyEventModalProps {
  event: DailyEvent;
  characterId: string | null;
  characterName?: string;
  onClose: () => void;
}

export function DailyEventModal({
  event,
  characterId,
  characterName,
  onClose,
}: DailyEventModalProps): React.ReactElement {
  const navigate = useNavigate();
  const name = characterName ?? 'TA';

  const fill = (s: string): string => s.replaceAll('{name}', name);

  const choose = (prompt: string): void => {
    if (characterId) {
      navigate(`/chat?c=${characterId}&auto=${encodeURIComponent(prompt)}`);
    }
    onClose();
  };

  return (
    <Modal
      open
      title={`${event.icon} ${fill(event.title)}`}
      description={fill(event.body)}
      onClose={onClose}
    >
      <div className="mt-1 flex flex-col gap-2">
        {event.options.map((o, i) => (
          <button
            key={i}
            onClick={() => choose(o.prompt)}
            className="rounded-2xl bg-[var(--xl-mist)]/70 px-4 py-3 text-left text-[14px] text-[var(--xl-ink)] active:opacity-70"
          >
            {o.label}
          </button>
        ))}
      </div>
    </Modal>
  );
}

export default DailyEventModal;
