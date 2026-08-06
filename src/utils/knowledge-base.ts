/**
 * 帮助 → 常见问题/百科 的条目定义。
 * 标题/摘要/正文均存 i18n key（随界面语言切换），由 KnowledgeBaseModal 按当前语言翻译渲染。
 * 正文支持的元素类型见 KnowledgeBaseModal 的 KBBlock 渲染。
 */
export interface KBBlock {
  type: 'text' | 'code' | 'link' | 'table'
  /** text / link 的文案 i18n key */
  text?: string
  /** code 块：第一行是命令/代码，其余行是说明 */
  lines?: string[]
  /** link 行的跳转地址 */
  href?: string
  /** table 块：表头与每行 cell 均为 i18n key，行内 cell 数与 headers 对齐 */
  table?: {
    headers: string[]
    rows: string[][]
  }
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
  },
  {
    id: 'rs232-signals',
    titleKey: 'knowBase.entries.rs232Signals.title',
    summaryKey: 'knowBase.entries.rs232Signals.summary',
    blocks: [
      { type: 'text', text: 'knowBase.entries.rs232Signals.b0' },
      {
        type: 'table',
        table: {
          headers: [
            'knowBase.entries.rs232Signals.tblCat',
            'knowBase.entries.rs232Signals.tblSignal',
            'knowBase.entries.rs232Signals.tblDesc'
          ],
          rows: [
            [
              'knowBase.entries.rs232Signals.catData',
              'knowBase.entries.rs232Signals.sigData',
              'knowBase.entries.rs232Signals.descData'
            ],
            [
              'knowBase.entries.rs232Signals.catHandshake',
              'knowBase.entries.rs232Signals.sigHandshake',
              'knowBase.entries.rs232Signals.descHandshake'
            ],
            [
              'knowBase.entries.rs232Signals.catHandshake',
              'knowBase.entries.rs232Signals.sigHandshake2',
              'knowBase.entries.rs232Signals.descHandshake2'
            ],
            [
              'knowBase.entries.rs232Signals.catTiming',
              'knowBase.entries.rs232Signals.sigTiming',
              'knowBase.entries.rs232Signals.descTiming'
            ]
          ]
        }
      },
      { type: 'text', text: 'knowBase.entries.rs232Signals.b1' },
      { type: 'text', text: 'knowBase.entries.rs232Signals.b2' },
      { type: 'text', text: 'knowBase.entries.rs232Signals.b3' },
      { type: 'link', text: 'knowBase.entries.rs232Signals.b4', href: 'https://yost.com/computers/RJ45-serial/' }
    ]
  }
]
