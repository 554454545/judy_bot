// 项目时间格式：固定使用北京时间 UTC+8；日志及文件命名共用，Unix 时间戳保持原值。
export function beijingIsoTime(value: Date | string | number = new Date()): string {
  const instant = value instanceof Date ? value : new Date(value);
  return new Date(instant.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .replace("Z", "+08:00");
}

export function beijingFilenameTime(value: Date | string | number = new Date()): string {
  return beijingIsoTime(value).replace(/[:.]/g, "-");
}
