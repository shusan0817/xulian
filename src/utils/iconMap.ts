import {
  Bot,
  Code,
  Globe,
  Sparkles,
  FileText,
  Lightbulb
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// Icon 映射（用 lucide 官方的 LucideIcon 类型，避免手写 props 与 ref 类型不兼容）
export const ICON_MAP: Record<string, LucideIcon> = {
  Bot,
  Sparkles,
  Code,
  FileText,
  Globe,
  Lightbulb,
};
