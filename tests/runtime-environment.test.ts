import { describe, expect, it } from 'vitest'
import { detectRuntimeEnvironment, formatRuntimeEnvironmentPrompt } from '../src/main/runtime-environment'

describe('runtime environment detection', () => {
  it('describes a Linux X11 desktop with POSIX command rules', () => {
    const info = detectRuntimeEnvironment({
      platform: 'linux',
      architecture: 'x64',
      release: '6.17.0',
      osType: 'Linux',
      env: { SHELL: '/bin/bash', DISPLAY: ':1', XDG_CURRENT_DESKTOP: 'GNOME' }
    })
    const prompt = formatRuntimeEnvironmentPrompt(info)

    expect(prompt).toContain('操作系统：Linux（linux）')
    expect(prompt).toContain('图形会话：X11')
    expect(prompt).toContain('默认 Shell：/bin/bash')
    expect(prompt).toContain('Linux/POSIX')
    expect(prompt).toContain('不要生成 Windows 或 macOS 专用命令')
  })

  it('describes Windows with Windows path and shell rules', () => {
    const info = detectRuntimeEnvironment({
      platform: 'win32',
      architecture: 'x64',
      release: '10.0.26100',
      osType: 'Windows_NT',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
    })
    const prompt = formatRuntimeEnvironmentPrompt(info)

    expect(prompt).toContain('操作系统：Windows（win32）')
    expect(prompt).toContain('路径风格：Windows')
    expect(prompt).toContain('C:\\Windows\\System32\\cmd.exe')
    expect(prompt).toContain('PowerShell')
  })

  it('marks a headless Linux session without claiming desktop UI is impossible', () => {
    const info = detectRuntimeEnvironment({ platform: 'linux', env: { SHELL: '/bin/sh' } })
    const prompt = formatRuntimeEnvironmentPrompt(info)

    expect(info.graphicsSession).toContain('可能是无头会话')
    expect(prompt).toContain('不得仅根据 SSH 或远程环境猜测宿主没有图形界面')
  })
})
