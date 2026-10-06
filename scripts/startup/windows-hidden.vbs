' Windows 无窗口启动宿主：等待同目录 windows.ps1 常驻入口，保持任务运行状态。
' 关联：windows.ps1 注册本文件为任务动作；telegram.mjs 负责项目 Pi 和 TG。
' 边界：不启动终端、不操作其他任务；PowerShell 退出码返回任务计划程序。
Option Explicit
Dim shell, files, scriptPath, command, result
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
scriptPath = files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), "windows.ps1")
command = """" & shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & scriptPath & """ -Action Run"
result = shell.Run(command, 0, True)
WScript.Quit result
