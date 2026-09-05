/** @type {import('tailwindcss').Config} */

/**
 * 需恋色板（架构文档 §8.6）
 * 风格：温柔、低饱和、有陪伴感；白天偏奶油白，深色模式偏藕紫。
 * 说明：本文件只定义「设计 token」，具体语义色在 src/index.css 的 CSS 变量里
 *   （同一套 token 在浅色/深色下取不同值，组件只写 var(--xl-*)）。
 */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // ---- 核心色板 ----
        'xl-ink': '#2B2733', // 主文字
        'xl-sub': '#7A7288', // 次要文字
        'xl-bg': '#FBFAFC', // 页面背景
        'xl-card': '#FFFFFF', // 卡片 / AI 气泡
        'xl-mist': '#EFEAF6', // 分隔线 / 底栏
        'xl-blush': '#F2A9B8', // 品牌粉（主色）
        'xl-blush-deep': '#E07E93', // 按压态
        'xl-lilac': '#B9A7E8', // 辅助紫
        'xl-mint': '#8FD3C7', // 成功 / 平静
        'xl-amber': '#FFB86B', // 开心 / 提醒

        // ---- 深色模式对应色（用 dark: 变体直接取用）----
        'xl-dark-bg': '#1B1822',
        'xl-dark-card': '#262231',
        'xl-dark-mist': '#332E40',
        'xl-dark-ink': '#F3F0F7',
        'xl-dark-sub': '#A79FB6',

        // ---- 兼容模板遗留 token（避免旧组件报错）----
        background: 'var(--td-bg-color-page, #FBFAFC)',
        foreground: 'var(--td-text-color-primary, #2B2733)',
        muted: {
          DEFAULT: 'var(--td-bg-color-component, #EFEAF6)',
          foreground: 'var(--td-text-color-secondary, #7A7288)',
        },
        border: 'var(--td-component-stroke, #EFEAF6)',
        input: 'var(--td-bg-color-component, #EFEAF6)',
        card: {
          DEFAULT: 'var(--td-bg-color-container, #FFFFFF)',
          foreground: 'var(--td-text-color-primary, #2B2733)',
        },
        accent: {
          DEFAULT: 'var(--td-brand-color, #F2A9B8)',
          foreground: 'var(--td-text-color-anti, #FFFFFF)',
          light: 'var(--td-brand-color-light, #F7C6D2)',
        },
        primary: {
          DEFAULT: 'var(--td-text-color-primary, #2B2733)',
          foreground: 'var(--td-bg-color-page, #FBFAFC)',
        },
      },
      borderRadius: {
        xl: '16px',
        '2xl': '20px',
        '3xl': '28px',
      },
      fontFamily: {
        sans: [
          'system-ui',
          '-apple-system',
          '"PingFang TC"',
          '"Microsoft JhengHei"',
          '"Noto Sans TC"',
          'sans-serif',
        ],
      },
      boxShadow: {
        card: '0 2px 12px rgba(43, 39, 51, 0.06)',
        bubble: '0 1px 4px rgba(43, 39, 51, 0.05)',
        sheet: '0 -8px 32px rgba(43, 39, 51, 0.12)',
      },
      animation: {
        'cursor-blink': 'blink 1s infinite',
        'typing-dot': 'typingDot 1.4s infinite ease-in-out',
        'fade-up': 'fadeUp 0.24s ease-out',
        'pop-in': 'popIn 0.28s cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
      keyframes: {
        blink: {
          '0%, 50%': { opacity: '1' },
          '51%, 100%': { opacity: '0' },
        },
        typingDot: {
          '0%, 60%, 100%': { transform: 'translateY(0)', opacity: '0.45' },
          '30%': { transform: 'translateY(-4px)', opacity: '1' },
        },
        fadeUp: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        popIn: {
          from: { opacity: '0', transform: 'scale(0.92)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
      },
    },
  },
  plugins: [],
  corePlugins: {
    // 保留 TDesign 的 reset，避免 Tailwind preflight 与它打架
    preflight: false,
  },
};
