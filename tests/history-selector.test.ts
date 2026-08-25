import { describe, expect, it } from 'vitest'
import { selectTaskHistory } from '../src/main/agent/history-selector'

type TestMessage = {
  role: 'user' | 'assistant'
  content: string
  attachments?: Array<{ id: string; name?: string }>
  status?: string
  steps?: Array<{ phase: 'reason' | 'skill' | 'act' | 'validate'; title: string; detail: string }>
}

describe('task history selection', () => {
  it('selects only the latest relevant task and removes unrelated historical screenshots', () => {
    const history: TestMessage[] = [
      { role: 'user', content: '优化这个页面', attachments: [{ id: 'old-screen', name: 'old.png' }] },
      { role: 'assistant', content: '页面已优化', status: 'succeeded' },
      { role: 'user', content: '启动另一个服务' },
      { role: 'assistant', content: '服务已启动', status: 'succeeded' },
      { role: 'user', content: "测试连接时报错：NoneType 没有 strip" },
      { role: 'assistant', content: '正在定位连接错误', status: 'failed' },
      { role: 'user', content: '继续' },
      { role: 'assistant', content: '任务已暂停', status: 'paused' }
    ]

    const selected = selectTaskHistory(history, '修复测试连接的 NoneType strip 问题')

    expect(selected.map((message) => message.content)).toEqual([
      "测试连接时报错：NoneType 没有 strip",
      '正在定位连接错误',
      '继续',
      '任务已暂停'
    ])
    expect(selected.every((message) => !message.attachments?.length)).toBe(true)
    expect(JSON.stringify(selected)).not.toContain('old-screen')
  })

  it('starts with no model history when a new task has no relevant segment', () => {
    const history: TestMessage[] = [
      { role: 'user', content: '调整首页颜色' },
      { role: 'assistant', content: '颜色已更新', status: 'succeeded' }
    ]

    expect(selectTaskHistory(history, '检查数据库迁移脚本')).toEqual([])
  })

  it('keeps the latest exchange when a follow-up uses contextual references', () => {
    const history: TestMessage[] = [
      { role: 'user', content: '检查数据库迁移脚本' },
      { role: 'assistant', content: '迁移脚本没有发现异常。', status: 'succeeded' },
      { role: 'user', content: '按用例复现检测流程' },
      { role: 'assistant', content: '依次执行标准检测、漏洞模式、冻结拍照、超分和报警拍照。', status: 'succeeded' }
    ]

    const selected = selectTaskHistory(history, '你确定是这些方法吗，你找到了报错的位置了吗')

    expect(selected.map((message) => message.content)).toEqual([
      '按用例复现检测流程',
      '依次执行标准检测、漏洞模式、冻结拍照、超分和报警拍照。'
    ])
  })

  it('reuses only the latest task attachment for an explicit continuation', () => {
    const history: TestMessage[] = [
      { role: 'user', content: '查看这张图', attachments: [{ id: 'current-screen', name: 'current.png' }] },
      { role: 'assistant', content: '图中存在连接错误', status: 'succeeded' }
    ]

    const selected = selectTaskHistory(history, '继续分析刚才的截图')

    expect(selected[0].attachments).toEqual([{ id: 'current-screen', name: 'current.png' }])
  })

  it('does not reuse historical attachments when the current request includes new ones', () => {
    const history: TestMessage[] = [
      { role: 'user', content: '查看这张图', attachments: [{ id: 'old-screen' }] },
      { role: 'assistant', content: '旧图分析', status: 'succeeded' }
    ]

    const selected = selectTaskHistory(history, '继续看图', { hasCurrentAttachments: true })

    expect(selected.every((message) => !message.attachments?.length)).toBe(true)
  })

  it('keeps bounded tool memory for both successful and resumable tasks', () => {
    const successful: TestMessage[] = [
      { role: 'user', content: '检查 package.json' },
      { role: 'assistant', content: '检查完成', status: 'succeeded', steps: [{ phase: 'act', title: 'Observation #1：read_file', detail: 'old trace' }] }
    ]
    const resumable: TestMessage[] = [
      { role: 'user', content: '检查 package.json' },
      {
        role: 'assistant',
        content: '检查尚未完成',
        status: 'paused',
        steps: Array.from({ length: 5 }, (_, index) => ({
          phase: 'act' as const,
          title: 'Observation #' + (index + 1) + '：read_file',
          detail: 'trace-' + (index + 1)
        }))
      }
    ]

    const completedSelection = selectTaskHistory(successful, '继续检查 package.json')
    const resumedSelection = selectTaskHistory(resumable, '继续检查 package.json')

    expect(completedSelection[1].content).toContain('检查完成')
    expect(completedSelection[1].content).toContain('old trace')
    expect(resumedSelection[1].content).not.toContain('trace-1')
    expect(resumedSelection[1].content).not.toContain('trace-2')
    expect(resumedSelection[1].content).toContain('trace-3')
    expect(resumedSelection[1].content).toContain('trace-5')
    expect(resumedSelection[1].steps).toBeUndefined()
  })

  it('drops an assistant protocol echo before reusing task history', () => {
    const history: TestMessage[] = [
      { role: 'user', content: '读取 package.json 并总结' },
      {
        role: 'assistant',
        content: '已整理结果。\n\nObservation #1:\nread_file: {...}\nPrevious task memory: {...}',
        status: 'succeeded',
        steps: [{ phase: 'act', title: 'Observation #1：read_file', detail: '{"name":"codext-agent"}' }]
      }
    ]

    const selected = selectTaskHistory(history, '继续检查 package.json')

    expect(selected[1].content).not.toContain('Observation #1:\nread_file: {...}')
    expect(selected[1].content).toContain('Previous task memory:')
    expect(selected[1].content).toContain('{"name":"codext-agent"}')
  })

  it('matches follow-up questions against facts introduced by the assistant and tool trace', () => {
    const history: TestMessage[] = [
      { role: 'user', content: '启动这个服务' },
      {
        role: 'assistant',
        content: '演示服务已启动，监听 http://localhost:3100/',
        status: 'succeeded',
        steps: [{ phase: 'act', title: 'Observation #1：read_file', detail: '文件 demo.js 中定义了 /api/weather 接口' }]
      }
    ]

    const selected = selectTaskHistory(history, 'demo.js 里的天气接口为什么返回空数据？')

    expect(selected).toHaveLength(2)
    expect(selected[1].content).toContain('demo.js')
    expect(selected[1].content).toContain('/api/weather')
  })

  it('retains the latest durable file observation alongside recent command results', () => {
    const history: TestMessage[] = [
      { role: 'user', content: '检查并启动 demo.js' },
      {
        role: 'assistant',
        content: '检查和启动已完成',
        status: 'succeeded',
        steps: [
          { phase: 'act', title: 'Observation #1：read_file', detail: '关键配置 port = 3100' },
          { phase: 'act', title: 'Observation #2：run_command', detail: 'command-2' },
          { phase: 'act', title: 'Observation #3：run_command', detail: 'command-3' },
          { phase: 'act', title: 'Observation #4：run_command', detail: 'command-4' },
          { phase: 'act', title: 'Observation #5：run_command', detail: 'command-5' }
        ]
      }
    ]

    const selected = selectTaskHistory(history, '继续检查 demo.js')

    expect(selected[1].content).toContain('关键配置 port = 3100')
    expect(selected[1].content).not.toContain('command-2')
    expect(selected[1].content).toContain('command-5')
  })
})
