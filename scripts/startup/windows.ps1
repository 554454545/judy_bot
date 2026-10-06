# Windows 登录自启动：注册当前账户的 TG 常驻任务，持续调用 WSL，并在退出后重试。
# 关联：同目录 telegram.mjs → 项目 start.sh；README.md 记录管理与验证方式。
# 边界：只管理 Workspace-Bot-Telegram 任务和 Ubuntu-22.04 内的本项目，不修改电源或全局 Pi。
param(
    [ValidateSet('Install', 'Run', 'Status', 'Restart', 'Stop', 'Disable')]
    [string]$Action = 'Status'
)
$ErrorActionPreference = 'Stop'
$taskName = 'Workspace-Bot-Telegram'
$description = 'Workspace bot Telegram frontend; project scripts/startup/windows.ps1'
$distribution = 'Ubuntu-22.04'
$linuxUser = 'judy'
$linuxRoot = '/home/judy/workspace/bot'
$nodePath = '/home/judy/.nvm/versions/node/v22.23.2/bin/node'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name

function Stop-ProjectRuntime {
    # 停止 Windows 任务不保证 WSL 子进程退出；按完整项目入口匹配，正常结束 Pi。
    Stop-ScheduledTask -TaskName $taskName
    $pattern = '^' + [regex]::Escape($nodePath + ' ' + $linuxRoot + '/scripts/startup/telegram.mjs') + '$'
    & "$env:SystemRoot\System32\wsl.exe" --distribution $distribution --user $linuxUser --exec /usr/bin/pkill -TERM -f $pattern
    if ($LASTEXITCODE -gt 1) {
        throw 'Could not stop the project WSL process.'
    }
}

switch ($Action) {
    'Install' {
        $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($existing -and $existing.Description -ne $description) {
            throw 'Task name already exists with a different owner; refusing to replace it.'
        }
        # 无控制台宿主持有 PowerShell，避免终端关闭信号结束常驻任务。
        $arguments = '//B //Nologo "' + (Join-Path $PSScriptRoot 'windows-hidden.vbs') + '"'
        $taskAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument $arguments
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
        $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
        Register-ScheduledTask -TaskName $taskName -Description $description -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
        Start-ScheduledTask -TaskName $taskName
        Write-Output 'Registered and started Workspace-Bot-Telegram.'
    }
    'Run' {
        # 保持 wsl.exe 前台调用：终端关闭或锁屏不结束此任务，不依赖用户 systemd 总线。
        $command = 'umask 077; mkdir -p "' + $linuxRoot + '/.pi/agent/logs/startup"; cd "' + $linuxRoot + '"; exec /usr/bin/flock -n -E 75 "' + $linuxRoot + '/.pi/agent/logs/startup/runtime.lock" "' + $nodePath + '" "' + $linuxRoot + '/scripts/startup/telegram.mjs" >> "' + $linuxRoot + '/.pi/agent/logs/startup/runtime.log" 2>> "' + $linuxRoot + '/.pi/agent/logs/startup/stderr.log"'
        $baseCommand = $command
        while ($true) {
            # 只读当前账户的 Windows 系统代理，传给本项目；不修改全局网络设置。
            $proxyPrefix = ''
            $proxySettings = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
            if ($proxySettings.ProxyEnable -eq 1 -and $proxySettings.ProxyServer) {
                $server = [string]$proxySettings.ProxyServer
                if ($server.Contains('=')) {
                    $entry = ($server -split ';' | Where-Object { $_ -match '^https=' } | Select-Object -First 1)
                    if (-not $entry) {
                        $entry = ($server -split ';' | Where-Object { $_ -match '^http=' } | Select-Object -First 1)
                    }
                    $server = ($entry -split '=', 2)[-1]
                }
                # 限定 host:port，避免将任意注册表文字解释为 Shell 命令。
                if ($server -notmatch '^[a-zA-Z0-9.-]+:[0-9]{1,5}$') {
                    throw 'Unsupported Windows proxy address; expected host:port.'
                }
                $proxyPrefix = "export HTTP_PROXY='http://" + $server + "' HTTPS_PROXY='http://" + $server + "'; "
            }
            $command = $proxyPrefix + $baseCommand
            # 显式禁止 wsl.exe 创建控制台；父 PowerShell 的 Hidden 不会自动传递给子进程。
            $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($command))
            $startInfo = New-Object System.Diagnostics.ProcessStartInfo
            $startInfo.FileName = "$env:SystemRoot\System32\wsl.exe"
            $startInfo.Arguments = '--distribution ' + $distribution + ' --user ' + $linuxUser + ' --exec /bin/bash -c "echo ' + $encoded + ' | base64 -d | /bin/bash"'
            $startInfo.UseShellExecute = $false
            $startInfo.CreateNoWindow = $true
            $startInfo.RedirectStandardOutput = $true
            $startInfo.RedirectStandardError = $true
            $process = New-Object System.Diagnostics.Process
            $process.StartInfo = $startInfo
            try {
                [void]$process.Start()
                $stdout = $process.StandardOutput.ReadToEndAsync()
                $stderr = $process.StandardError.ReadToEndAsync()
                $process.WaitForExit()
                # 消耗宿主输出，避免代理警告弹窗或堵塞；Pi 的诊断仍写在项目日志。
                [void]$stdout.GetAwaiter().GetResult()
                [void]$stderr.GetAwaiter().GetResult()
            } finally {
                $process.Dispose()
            }
            Start-Sleep -Seconds 30
        }
    }
    'Status' {
        Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
        Get-ScheduledTaskInfo -TaskName $taskName | Select-Object LastRunTime, LastTaskResult, NextRunTime
    }
    'Restart' {
        Stop-ProjectRuntime
        Start-ScheduledTask -TaskName $taskName
    }
    'Stop' {
        Stop-ProjectRuntime
    }
    'Disable' {
        Disable-ScheduledTask -TaskName $taskName | Out-Null
        Stop-ProjectRuntime
    }
}
