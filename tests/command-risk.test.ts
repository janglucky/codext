import { describe, expect, it } from 'vitest'
import { classifyCommandRisk } from '../src/main/tools/command-risk'

describe('command risk classification', () => {
  it('allows local and SSH read-only inspection commands', () => {
    expect(classifyCommandRisk('cmd', ['/c', 'dir', 'C:\\work']).level).toBe('read')
    expect(classifyCommandRisk('git', ['status', '--short']).level).toBe('read')
    expect(classifyCommandRisk('ssh', ['user@166-server', 'find /home/guider/work -maxdepth 2 -type f']).level).toBe('read')
    expect(classifyCommandRisk('ssh', ['user@166-server', 'cat /home/guider/work/README.md']).level).toBe('read')
    expect(classifyCommandRisk('ssh', ['user@166-server', 'grep rm /home/guider/work/README.md']).level).toBe('read')
  })

  it('requires approval for commands that may write or execute scripts', () => {
    expect(classifyCommandRisk('cmd', ['/c', 'echo hello > output.txt']).level).toBe('write')
    expect(classifyCommandRisk('npm', ['install']).level).toBe('write')
    expect(classifyCommandRisk('node', ['script.js']).level).toBe('write')
    expect(classifyCommandRisk('ssh', ['user@166-server', 'cp source target']).level).toBe('write')
  })

  it('blocks destructive local and remote commands', () => {
    expect(classifyCommandRisk('cmd', ['/c', 'del important.txt']).level).toBe('blocked')
    expect(classifyCommandRisk('git', ['reset', '--hard']).level).toBe('blocked')
    expect(classifyCommandRisk('ssh', ['user@166-server', 'rm -rf /home/guider/work']).level).toBe('blocked')
    expect(classifyCommandRisk('ssh', ['user@166-server', 'sudo rm -rf /home/guider/work']).level).toBe('blocked')
    expect(classifyCommandRisk('ssh', ['user@166-server', 'find /home/guider/work -type f -delete']).level).toBe('blocked')
  })
})
