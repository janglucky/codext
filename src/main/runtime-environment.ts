import { arch as hostArch, release as hostRelease, type as hostType } from 'node:os'

export interface RuntimeEnvironmentInfo {
  platform: NodeJS.Platform
  osName: string
  osType: string
  release: string
  architecture: string
  shell: string
  desktop: string
  graphicsSession: string
  pathStyle: 'Windows' | 'POSIX'
}

interface RuntimeEnvironmentSource {
  platform?: NodeJS.Platform
  architecture?: string
  release?: string
  osType?: string
  env?: NodeJS.ProcessEnv
}

export function detectRuntimeEnvironment(source: RuntimeEnvironmentSource = {}): RuntimeEnvironmentInfo {
  const platform = source.platform ?? process.platform
  const env = source.env ?? process.env
  const osName = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : source.osType ?? hostType()
  const shell = platform === 'win32'
    ? env.ComSpec?.trim() || env.COMSPEC?.trim() || 'cmd.exe'
    : env.SHELL?.trim() || '未检测到默认 Shell'
  const desktop = env.XDG_CURRENT_DESKTOP?.trim() || env.DESKTOP_SESSION?.trim() || (platform === 'darwin' ? 'Aqua' : platform === 'win32' ? 'Windows Desktop' : '未检测到桌面环境')
  const graphicsSession = platform === 'win32'
    ? 'Windows 图形会话'
    : platform === 'darwin'
      ? 'macOS 图形会话'
      : env.WAYLAND_DISPLAY?.trim()
        ? 'Wayland（WAYLAND_DISPLAY 已设置）'
        : env.DISPLAY?.trim()
          ? 'X11（DISPLAY 已设置）'
          : '未检测到 DISPLAY/WAYLAND_DISPLAY，可能是无头会话'

  return {
    platform,
    osName,
    osType: source.osType ?? hostType(),
    release: source.release ?? hostRelease(),
    architecture: source.architecture ?? hostArch(),
    shell,
    desktop,
    graphicsSession,
    pathStyle: platform === 'win32' ? 'Windows' : 'POSIX'
  }
}

export function formatRuntimeEnvironmentPrompt(info: RuntimeEnvironmentInfo): string {
  const commandConvention = info.platform === 'win32'
    ? '使用 Windows 可执行程序与路径规则；仅在必要时通过 cmd.exe 或 PowerShell 执行相应命令。'
    : info.platform === 'darwin'
      ? '使用 macOS/POSIX 可执行程序、Shell 和路径规则；不要生成 Windows 专用命令。'
      : '使用 Linux/POSIX 可执行程序、Shell 和路径规则；不要生成 Windows 或 macOS 专用命令。'

  return [
    '宿主运行环境（应用启动时自动检测；如果历史或自定义提示与此冲突，以本节为准）：',
    '- 操作系统：' + info.osName + '（' + info.platform + '）',
    '- 系统内核/版本：' + info.osType + ' ' + info.release,
    '- CPU 架构：' + info.architecture,
    '- 默认 Shell：' + info.shell,
    '- 桌面环境：' + info.desktop,
    '- 图形会话：' + info.graphicsSession,
    '- 路径风格：' + info.pathStyle,
    '命令与路径必须严格匹配上述宿主环境。' + commandConvention + '不得仅根据 SSH 或远程环境猜测宿主没有图形界面。'
  ].join('\n')
}
