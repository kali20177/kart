/**
 * 帮助 → 常见问题/百科 的条目定义。
 * 标题/摘要/正文均存 i18n key（随界面语言切换），由 KnowledgeBaseModal 按当前语言翻译渲染。
 * 正文支持的元素类型见 KnowledgeBaseModal 的 KBBlock 渲染。
 */
export interface KBBlock {
  type: 'text' | 'code' | 'link'
  /** text / link 的文案 i18n key */
  text?: string
  /** code 块：第一行是命令/代码，其余行是说明 */
  lines?: string[]
  /** link 行的跳转地址 */
  href?: string
}

export interface KBEntryMeta {
  id: string
  titleKey: string
  summaryKey: string
  blocks: KBBlock[]
}

/** 内置条目（展示顺序即数组顺序） */
export const KB_ENTRIES: KBEntryMeta[] = [
  {
    id: 'macos-tty-cu',
    titleKey: 'knowBase.entries.macosTtyCu.title',
    summaryKey: 'knowBase.entries.macosTtyCu.summary',
    blocks: [
      { type: 'text', text: 'knowBase.entries.macosTtyCu.b0' },
      {
        type: 'code',
        lines: ['/dev/tty.usbserial-2430  （dialin，拨入）', '/dev/cu.usbserial-2430  （callout，拨出）']
      },
      { type: 'text', text: 'knowBase.entries.macosTtyCu.b1' },
      { type: 'text', text: 'knowBase.entries.macosTtyCu.b2' },
      { type: 'text', text: 'knowBase.entries.macosTtyCu.b3' },
      { type: 'link', text: 'knowBase.entries.macosTtyCu.b4', href: 'https://stackoverflow.com/questions/8632586' }
    ]
  },
  {
    id: 'cannot-open-port',
    titleKey: 'knowBase.entries.cannotOpenPort.title',
    summaryKey: 'knowBase.entries.cannotOpenPort.summary',
    blocks: [
      { type: 'text', text: 'knowBase.entries.cannotOpenPort.b0' },
      { type: 'text', text: 'knowBase.entries.cannotOpenPort.b1' },
      { type: 'text', text: 'knowBase.entries.cannotOpenPort.b2' },
      { type: 'text', text: 'knowBase.entries.cannotOpenPort.b3' },
      { type: 'text', text: 'knowBase.entries.cannotOpenPort.b4' }
    ]
  }
]
