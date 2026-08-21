// Typed environment variable getters with sane fallback defaults.

export function getEnvString(name: string, defaultValue: string): string {
  const value = process.env[name];
  return value !== undefined && value !== "" ? value : defaultValue;
}

export function getEnvInt(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function getEnvBool(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  return defaultValue;
}
