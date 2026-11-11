const secretName = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTH/i;

export function redactor(extra: string[] = []) {
  const values = [...extra, ...Object.entries(process.env)
    .filter(([key]) => secretName.test(key)).map(([, value]) => value ?? '')]
    .filter(value => value.length >= 8).sort((a, b) => b.length - a.length);
  return (value: string) => {
    for (const secret of values) value = value.replaceAll(secret, '[REDACTED]');
    return value
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
      .replace(/\b(?:Bearer|Basic)\s+[a-z0-9._~+/=-]{8,}/gi, '[REDACTED]')
      .replace(/\b(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{12,}|github_pat_[a-z0-9_]{12,}|AIza[a-z0-9_-]{25,}|AKIA[A-Z0-9]{16})\b/gi, '[REDACTED]')
      .replace(/((?:token|api[_-]?key|secret|password)["']?\s*[:=]\s*["']?)[^\s"',;}{]+/gi, '$1[REDACTED]')
      .replace(/(https?:\/\/)[^/\s@]+:[^/\s@]+@/gi, '$1[REDACTED]@');
  };
}
